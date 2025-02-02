// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.13;

import "./utils/MinimalProxyable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IAddressResolver.sol";
import "./interfaces/IFuturesMarket.sol";
import "./interfaces/IFuturesMarketManager.sol";

/// @title Kwenta MarginBase Account
/// @author JaredBorders and JChiaramonte7
/// @notice Flexible, minimalist, and gas-optimized cross-margin enabled account
/// for managing perpetual futures positions
contract MarginBase is MinimalProxyable {
    /*///////////////////////////////////////////////////////////////
                                Constants
    ///////////////////////////////////////////////////////////////*/

    // tracking code used when modifying positions
    bytes32 private constant TRACKING_CODE = "KWENTA";

    // name for futures market manager, needed for fetching market key
    bytes32 private constant FUTURES_MANAGER = "FuturesMarketManager";

    /*///////////////////////////////////////////////////////////////
                                Types
    ///////////////////////////////////////////////////////////////*/

    // marketKey: synthetix futures market id/key
    // margin: amount of margin (in sUSD) in specific futures market
    // size: denoted in market currency (i.e. ETH, BTC, etc), size of futures position
    struct ActiveMarketPosition {
        bytes32 marketKey;
        uint128 margin;
        int128 size;
    }

    // marketKey: synthetix futures market id/key
    // marginDelta: amount of margin (in sUSD) to deposit or withdraw
    // sizeDelta: denoted in market currency (i.e. ETH, BTC, etc), size of futures position
    // isClosing: indicates if position needs to be closed
    struct UpdateMarketPositionSpec {
        bytes32 marketKey;
        int256 marginDelta; // positive indicates deposit, negative withdraw
        int256 sizeDelta;
        bool isClosing; // if true, marginDelta nor sizeDelta are considered. simply closes position
    }

    /*///////////////////////////////////////////////////////////////
                                State
    ///////////////////////////////////////////////////////////////*/

    /// @notice synthetix address resolver
    IAddressResolver private addressResolver;

    /// @notice synthetix futures market manager
    IFuturesMarketManager private futuresManager;

    /// @notice token contract used for account margin
    IERC20 public marginAsset;

    /// @notice market keys that the account has active positions in
    bytes32[] public activeMarketKeys;

    /// @notice market keys mapped to active market positions
    mapping(bytes32 => ActiveMarketPosition) public activeMarketPositions;

    /*///////////////////////////////////////////////////////////////
                                Events
    ///////////////////////////////////////////////////////////////*/

    /// @notice emitted after a successful deposit
    /// @param user: the address that deposited into account
    /// @param amount: amount of marginAsset to deposit into marginBase account
    event Deposit(address indexed user, uint256 amount);

    /// @notice emitted after a successful withdrawal
    /// @param user: the address that withdrew from account
    /// @param amount: amount of marginAsset to withdraw from marginBase account
    event Withdraw(address indexed user, uint256 amount);

    /*///////////////////////////////////////////////////////////////
                                Errors
    ///////////////////////////////////////////////////////////////*/

    /// @notice amount deposited/withdrawn into/from account cannot be zero
    error AmountCantBeZero();

    /// @notice position with given marketKey does not exist
    /// @param marketKey: key for synthetix futures market
    error MissingMarketKey(bytes32 marketKey);

    /// @notice limit size of new position specs passed into distribute margin
    /// @param numberOfNewPositions: number of new position specs
    error MaxNewPositionsExceeded(uint256 numberOfNewPositions);

    /// @notice market withdrawal size was positive (i.e. deposit)
    /// @param withdrawalSize: amount of margin asset to withdraw from market
    error InvalidMarketWithdrawSize(int256 withdrawalSize);

    /// @notice market deposit size was negative (i.e. withdraw)
    /// @param depositSize: amount of margin asset to deposit into market
    error InvalidMarketDepositSize(int256 depositSize);

    /*///////////////////////////////////////////////////////////////
                        Constructor & Initializer
    ///////////////////////////////////////////////////////////////*/

    /// @notice constructor never used except for first CREATE
    // solhint-disable-next-line
    constructor() MinimalProxyable() {}

    /// @notice initialize contract (only once) and transfer ownership to caller
    /// @param _marginAsset: token contract address used for account margin
    /// @param _addressResolver: contract address for synthetix address resolver
    function initialize(address _marginAsset, address _addressResolver)
        external
        initOnce
    {
        addressResolver = IAddressResolver(_addressResolver);
        futuresManager = IFuturesMarketManager(
            addressResolver.requireAndGetAddress(
                FUTURES_MANAGER,
                "MarginBase: Could not get Futures Market Manager"
            )
        );
        marginAsset = IERC20(_marginAsset);

        /// @dev the Ownable constructor is never called when we create minimal proxies
        _transferOwnership(msg.sender);
    }

    /*///////////////////////////////////////////////////////////////
                                Views
    ///////////////////////////////////////////////////////////////*/

    /// @notice get number of active market positions account has
    /// @return number of positions which are currently active for account
    function getNumberOfActivePositions() external view returns (uint256) {
        return activeMarketKeys.length;
    }

    /// @notice get all active market positions
    /// @return positions which are currently active for account (ActiveMarketPosition structs)
    function getAllActiveMarketPositions()
        external
        view
        returns (ActiveMarketPosition[] memory)
    {
        ActiveMarketPosition[] memory positions = new ActiveMarketPosition[](
            activeMarketKeys.length
        );
        for (uint16 i = 0; i < activeMarketKeys.length; i++) {
            positions[i] = (activeMarketPositions[activeMarketKeys[i]]);
        }
        return positions;
    }

    /*///////////////////////////////////////////////////////////////
                        Account Deposit & Withdraw
    ///////////////////////////////////////////////////////////////*/

    /// @param _amount: amount of marginAsset to deposit into marginBase account
    function deposit(uint256 _amount)
        external
        onlyOwner
    {   
        /// @notice amount deposited into account cannot be zero
        if (_amount == 0) {
            revert AmountCantBeZero();
        }

        // transfer in margin asset from user
        // (will revert if user does not have amount specified)
        require(
            marginAsset.transferFrom(owner(), address(this), _amount),
            "MarginBase: deposit failed"
        );

        emit Deposit(msg.sender, _amount);
    }

    /// @param _amount: amount of marginAsset to withdraw from marginBase account
    function withdraw(uint256 _amount)
        external
        onlyOwner
    {
        /// @notice amount withdrawn from account cannot be zero
        if (_amount == 0) {
            revert AmountCantBeZero();
        }

        // transfer out margin asset to user
        // (will revert if account does not have amount specified)
        require(
            marginAsset.transfer(owner(), _amount),
            "MarginBase: withdraw failed"
        );

        emit Withdraw(msg.sender, _amount);
    }

    /*///////////////////////////////////////////////////////////////
                            Margin Distribution
    ///////////////////////////////////////////////////////////////*/

    /// @notice distribute margin across all/some positions specified via _newPositions
    /// @dev _newPositions may contain any number of new or existing positions
    /// @dev caller can close and withdraw all margin from position if _newPositions[i].isClosing is true
    /// @param _newPositions: an array of UpdateMarketPositionSpec's used to modify active market positions
    function distributeMargin(UpdateMarketPositionSpec[] calldata _newPositions)
        external
        onlyOwner
    {
        /// @notice limit size of new position specs passed into distribute margin
        if (_newPositions.length > type(uint16).max) {
            revert MaxNewPositionsExceeded(_newPositions.length);
        }

        // for each new position in _newPositions, distribute margin accordingly and update state
        for (uint16 i = 0; i < _newPositions.length; i++) {
            if (_newPositions[i].isClosing) {
                /// @notice close position and transfer margin back to account
                closePositionAndWithdraw(_newPositions[i].marketKey);
            } else if (_newPositions[i].marginDelta < 0) {
                /// @notice remove margin from market and potentially adjust size
                modifyPositionForMarketAndWithdraw(
                    _newPositions[i].marginDelta,
                    _newPositions[i].sizeDelta,
                    _newPositions[i].marketKey
                );
            } else {
                /// @dev marginDelta >= 0
                /// @notice deposit margin into market and potentially adjust size
                depositAndModifyPositionForMarket(
                    _newPositions[i].marginDelta,
                    _newPositions[i].sizeDelta,
                    _newPositions[i].marketKey
                );
                // if marginDelta is 0, there will simply be NO additional
                // margin deposited into the market
            }
        }
    }

    /*///////////////////////////////////////////////////////////////
                    Internal Margin Distribution
    ///////////////////////////////////////////////////////////////*/

    /// @notice deposit margin into specific market, creating/adding to a position
    /// @param _depositSize: size of deposit in sUSD
    /// @param _sizeDelta: size and position type (long//short) denoted in market synth (ex: sETH)
    /// @param _marketKey: synthetix futures market id/key
    function depositAndModifyPositionForMarket(
        int256 _depositSize,
        int256 _sizeDelta,
        bytes32 _marketKey
    ) internal {
        // _depositSize must be positive or zero (i.e. not a withdraw)
        if (_depositSize < 0) {
            revert InvalidMarketDepositSize(_depositSize);
        }

        // define market via _marketKey
        IFuturesMarket market = futuresMarket(_marketKey);

        /// @notice alter the amount of margin in specific market position
        /// @dev positive input triggers a deposit; a negative one, a withdrawal
        market.transferMargin(_depositSize);

        /// @dev if _sizeDelta is 0, then we do not want to modify position size, only margin
        if (_sizeDelta != 0) {
            // modify position in specific market with KWENTA tracking code
            market.modifyPositionWithTracking(_sizeDelta, TRACKING_CODE);
        }

        // fetch new position data from Synthetix
        (, , uint128 margin, , int128 size) = market.positions(address(this));

        // update state for given open market position
        updateActiveMarketPosition(_marketKey, margin, size, market);
    }

    /// @notice modify active position and withdraw marginAsset from market into this account
    /// @param _withdrawalSize: size of sUSD to withdraw from market into account
    /// @param _sizeDelta: size and position type (long//short) denoted in market synth (ex: sETH)
    /// @param _marketKey: synthetix futures market id/key
    function modifyPositionForMarketAndWithdraw(
        int256 _withdrawalSize,
        int256 _sizeDelta,
        bytes32 _marketKey
    ) internal {
        // _withdrawalSize must be negative or zero (i.e. not a deposit)
        if (_withdrawalSize > 0) {
            revert InvalidMarketWithdrawSize(_withdrawalSize);
        }

        // define market via _marketKey
        IFuturesMarket market = futuresMarket(_marketKey);

        /// @dev if _sizeDelta is 0, then we do not want to modify position size, only margin
        if (_sizeDelta != 0) {
            // modify position in specific market with KWENTA tracking code
            market.modifyPositionWithTracking(_sizeDelta, TRACKING_CODE);
        }

        /// @notice alter the amount of margin in specific market position
        /// @dev positive input triggers a deposit; a negative one, a withdrawal
        market.transferMargin(_withdrawalSize);

        // fetch new position data from Synthetix
        (, , uint128 margin, , int128 size) = market.positions(address(this));

        // update state for given open market position
        updateActiveMarketPosition(_marketKey, margin, size, market);
    }

    /// @notice closes futures position and withdraws all margin in that market back to this account
    /// @param _marketKey: synthetix futures market id/key
    function closePositionAndWithdraw(bytes32 _marketKey) internal {
        // update state (remove market)
        removeActiveMarketPositon(_marketKey);

        // define market via _marketKey
        IFuturesMarket market = futuresMarket(_marketKey);

        // close market position
        market.closePosition();

        // withdraw margin back to this account
        market.withdrawAllMargin();
    }

    /*///////////////////////////////////////////////////////////////
                    Internal Account State Management
    ///////////////////////////////////////////////////////////////*/

    /// @notice used internally to update contract state for the account's active position tracking
    /// @param _marketKey: key for synthetix futures market
    /// @param _margin: amount of margin the specific market position has
    /// @param _size: represents size of position (i.e. accounts for leverage)
    /// @dev if _size becomes 0, remove position from account state and withdraw margin
    function updateActiveMarketPosition(
        bytes32 _marketKey,
        uint128 _margin,
        int128 _size,
        IFuturesMarket market
    ) internal {
        // if position size is 0, position is effectively closed on
        // FuturesMarket but margin is still in contract, thus it must
        // be withdrawn back to this account
        if (_size == 0) {
            // update state (remove market)
            removeActiveMarketPositon(_marketKey);

            // withdraw margin back to this account
            market.withdrawAllMargin();
            return;
        }

        ActiveMarketPosition memory newPosition = ActiveMarketPosition(
            _marketKey,
            _margin,
            _size
        );

        // check if this is updating a position or creating one
        if (activeMarketPositions[_marketKey].marketKey == 0) {
            activeMarketKeys.push(_marketKey);
        }

        // update state of active market positions
        activeMarketPositions[_marketKey] = newPosition;
    }

    /// @notice used internally to remove active market position from contract's internal state
    /// @param _marketKey: key for previously active market position
    function removeActiveMarketPositon(bytes32 _marketKey) internal {
        // ensure active market exists
        if (activeMarketPositions[_marketKey].marketKey == 0) {
            revert MissingMarketKey(_marketKey);
        }

        delete activeMarketPositions[_marketKey];
        uint256 numberOfActiveMarkets = activeMarketKeys.length;

        for (uint16 i = 0; i < numberOfActiveMarkets; i++) {
            // once _marketKey is encountered, swap with
            // last element in array and exit for-loop
            if (activeMarketKeys[i] == _marketKey) {
                activeMarketKeys[i] = activeMarketKeys[
                    numberOfActiveMarkets - 1
                ];
                break;
            }
        }
        // remove last element (which will be _marketKey)
        activeMarketKeys.pop();
    }

    /*///////////////////////////////////////////////////////////////
                Internal Futures Market Initialization
    ///////////////////////////////////////////////////////////////*/

    /// @notice addressResolver fetches IFuturesMarket address for specific market
    /// @param _marketKey: key for synthetix futures market
    /// @return IFuturesMarket contract interface
    function futuresMarket(bytes32 _marketKey)
        internal
        view
        returns (IFuturesMarket)
    {
        return IFuturesMarket(futuresManager.marketForKey(_marketKey));
    }
}
