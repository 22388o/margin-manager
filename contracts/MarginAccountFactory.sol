// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.13;

import "./utils/MinimalProxyFactory.sol";
import "./MarginBase.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Kwenta MarginBase Factory
/// @author JaredBorders and JChiaramonte7
/// @notice Factory which enables deploying a MarginBase account for any user 
contract MarginAccountFactory is MinimalProxyFactory {
    
    string public version; // format: (0.1.0)

    /*///////////////////////////////////////////////////////////////
                                Immutables
    ///////////////////////////////////////////////////////////////*/

    /// @notice MarginBase contract acting as user's account
    MarginBase public immutable implementation;

    /// @notice ERC20 token used to interact with markets
    IERC20 public immutable marginAsset;

    /// @notice synthetix address resolver
    address public immutable addressResolver;

    /*///////////////////////////////////////////////////////////////
                                Events
    ///////////////////////////////////////////////////////////////*/

    event NewAccount(address indexed owner, address account);

    /*///////////////////////////////////////////////////////////////
                                Constructor
    ///////////////////////////////////////////////////////////////*/

    /// @notice deploy MarginBase implementation to later be cloned
    /// @param _version: version of contract
    /// @param _marginAsset: token contract address used for account margin
    /// @param _addressResolver: contract address for synthetix address resolver
    constructor(
        string memory _version,
        address _marginAsset,
        address _addressResolver
    ) {
        version = _version;
        implementation = new MarginBase();
        marginAsset = IERC20(_marginAsset);
        addressResolver = _addressResolver;
    }

    /*///////////////////////////////////////////////////////////////
                            Account Deployment
    ///////////////////////////////////////////////////////////////*/

    /// @notice clone MarginBase (i.e. create new account for user)
    /// @dev this contract is the initial owner of cloned MarginBase,
    /// but ownership is transferred after successful initialization
    function newAccount() external returns (address) {
        MarginBase account = MarginBase(
            _cloneAsMinimalProxy(address(implementation), "Creation failure")
        );
        account.initialize(address(marginAsset), addressResolver);
        account.transferOwnership(msg.sender);

        emit NewAccount(msg.sender, address(account));
        return address(account);
    }
}
