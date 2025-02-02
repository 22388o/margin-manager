/* eslint-disable no-unused-expressions */
import { expect } from "chai";
import { artifacts, ethers, network, waffle } from "hardhat";
import { Contract } from "ethers";
import { mintToAccountSUSD } from "../utils/helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import dotenv from "dotenv";

dotenv.config();

/**
 * ########### SUMMARY ###########
 * MarginBase offers true cross-margin for users via the MarginBase.distributeMargin()
 * function. distributeMargin() gives the caller the flexibility to distribute margin
 * equally across all positions after opening/closing/modifying any/some/all market positions.
 * More specifically, distributeMargin() takes an array of objects defined by the caller
 * which represent market positions the account will take.
 * 
 * ########### START OF EXAMPLES ###########
 * New Position Objects are defined as:
 * {
 *      Market Key, 
 *      Margin in sUSD (negative denotes withdraw from market), 
 *      Size of Position (negative denotes short position)
 *      Boolean: will this position be closed (i.e. if true, close position)
 * }
 *
 * example (1.0):
 * If Tom deposits 10_000 sUSD into a MarginBase account, and then passes this array of
 * market positions to distributeMargin():
 *
 * [{sETH, 1_000, 1*10e18, false}, {sUNI, 1_000, -900*10e18, false}]
 *
 * Then he will have two active market positions: (1) 2x long in sETH and (2) 5x short in sUNI.
 * 
 * example (1.1):
 * Notice, Tom still has 8_000 sUSD of available margin which is not in either market. If
 * Tom wishes to use that margin, he can call distributeMargin() again with:
 *
 * [{sETH, 4_000, 0, false}, {sUNI, 4_000, 0, false}]
 *
 * That will increase the margin for each position, thus decreasing the leverage accordingly.
 * That will not change the size of either position; margin was simply deposited into each market.
 * Notice that the size of the positions specified in the above objects are "0". When a user wishes
 * to only deposit or withdraw margin, this is the correct method to do so. 
 *
 * example (1.2):
 * Notice that once a position has been taken by the account,
 * calling distributeMargin() with an array of market positions/orders that do not include the
 * currently active positions will work, as long as there is sufficient margin available for the
 * positions specified:
 *
 * Assume Tom deposits another 10_000 sUSD into his account. He could then call
 * distributeMargin() with:
 *
 * [{sBTC, 1_000, 0.5*10e18, false}]
 *
 * He will now have three active market positions: (1) long in sETH (2) short in sUNI and (3) long in sBTC.
 * Notice, only 11_000 of his 20_000 margin is being used in markets, but that can be changed quite
 * easily.
 * 
 * example (1.3):
 * Tom can also change the position sizes without altering the amount of margin in each 
 * active market position. He can do this by passing position objects with marginDelta set to "0"
 * and sizeDelta set to the newly desired size. An example of changing his above sETH long position
 * size and not altering his other positions:
 * 
 * [{sETH, 0, 5*10e18, false}]
 * 
 * His sETH is now 10x long position.
 * 
 * example (1.4):
 * Now, Tom wishes to withdraw margin from one of his positions. He can do so by
 * passing a new position into distributeMargin() that has a negative margin value:
 * 
 * [{sUNI, -(1_000), 0, false}]
 * 
 * The above position object results in the sUNI market losing $1_000 sUSD in margin and
 * Tom's account balance increasing by $1_000 sUSD (which can be deposited immediately
 * into another market, even in the same transaction).
 * 
 * example (2):
 * Assume Tom has a single long position in sETH made via:
 * 
 * [{sETH, 1_000, 1*10e18, false}
 * 
 * Tom wishes to close this position. He can do so simply by:
 * 
 * [{sETH, 0, 0, true}
 * 
 * Notice that size and margin do not matter. If `isClosing` is set to true, distributeMargin() will
 * immediately execute logic which will exit the position and tranfer all margin in that market back
 * to this account.
 *
 * ########### FINAL GOAL ###########
 * Ultimately, the goal of MarginBase is to offer users the flexibility to define cross margin
 * however they see fit. Single positions with limited margin relative to account margin is supported
 * as well as equally distrubted margin among all active market positions. It is up to the caller/front-end
 * to implement whatever strategy that best serves them.
 * 
 * ########### NOTES ###########
 * (1) Notice that there is an order fee taken when a futures position is opened
 *          which is relative to position size, thus deposited margin will not strictly 
 *          equal actual margin in market in the following tests. Expect difference 
 *          to be less than 1%.
 * 
 * (2) When closing a position, the margin will be transferred back to the 
 *          user's account, thus, that margin can be used in any subsequent
 *          new positions which may be opened/modified in the same transaction
 * ex: 
 * Assume a 1x BTC Long position already exists and then the following array of positions
 * is passed to distributeMargin:
 * 
 * [{sBTC, 0, 0, true}, {X}, {Y}, {Z}]
 * 
 * The first position object closes the BTC position, returning that margin to the account 
 * which can then be used to open or modify positions: X, Y, Z.
 *
 * @author jaredborders
 */

// constants
const MINT_AMOUNT = ethers.BigNumber.from("100000000000000000000000"); // == $100_000 sUSD
const ACCOUNT_AMOUNT = ethers.BigNumber.from("10000000000000000000000"); // == $10_000 sUSD
const TEST_VALUE = ethers.BigNumber.from("1000000000000000000000"); // == $1_000 sUSD

// synthetix
const ADDRESS_RESOLVER = "0x95A6a3f44a70172E7d50a9e28c85Dfd712756B8C";

// synthetix: proxy
const SUSD_PROXY = "0x8c6f28f2F1A3C87F0f938b96d27520d9751ec8d9";
let sUSD: Contract;

// synthetix: market keys
// see: https://github.com/Synthetixio/synthetix/blob/develop/publish/deployed/mainnet-ovm/futures-markets.json
const MARKET_KEY_sETH = ethers.utils.formatBytes32String("sETH");
const MARKET_KEY_sBTC = ethers.utils.formatBytes32String("sBTC");
const MARKET_KEY_sLINK = ethers.utils.formatBytes32String("sLINK");
const MARKET_KEY_sUNI = ethers.utils.formatBytes32String("sUNI");

// cross margin
let marginAccountFactory: Contract;
let marginAccount: Contract;

// test accounts
let account0: SignerWithAddress;

const forkAtBlock = async (block: number) => {
    await network.provider.request({
        method: "hardhat_reset",
        params: [
            {
                forking: {
                    jsonRpcUrl: process.env.ARCHIVE_NODE_URL_L2,
                    blockNumber: block,
                },
            },
        ],
    });
};

describe("Integration: Test Cross Margin", () => {
    before("Fork and Mint sUSD to Test Account", async () => {
        forkAtBlock(9000000);

        [account0] = await ethers.getSigners();

        // mint account0 $100_000 sUSD
        await mintToAccountSUSD(account0.address, MINT_AMOUNT);

        const IERC20ABI = (
            await artifacts.readArtifact(
                "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20"
            )
        ).abi;
        sUSD = new ethers.Contract(SUSD_PROXY, IERC20ABI, waffle.provider);
        const balance = await sUSD.balanceOf(account0.address);
        expect(balance).to.equal(MINT_AMOUNT);
    });

    it("Should deploy MarginAccountFactory contract", async () => {
        marginAccountFactory = await (
            await ethers.getContractFactory("MarginAccountFactory")
        ).deploy("1.0.0", SUSD_PROXY, ADDRESS_RESOLVER);
        expect(marginAccountFactory.address).to.exist;
    });

    it("Should deploy MarginBase contract and initialize it", async () => {
        const tx = await marginAccountFactory.connect(account0).newAccount();
        const rc = await tx.wait(); // 0ms, as tx is already confirmed
        const event = rc.events.find(
            (event: { event: string }) => event.event === "NewAccount"
        );
        const [owner, marginAccountAddress] = event.args;
        const MarginBaseABI = (
            await artifacts.readArtifact("contracts/MarginBase.sol:MarginBase")
        ).abi;
        marginAccount = new ethers.Contract(
            marginAccountAddress,
            MarginBaseABI,
            waffle.provider
        );
        expect(marginAccount.address).to.exist;

        // check sUSD is margin asset
        const marginAsset = await marginAccount.connect(account0).marginAsset();
        expect(marginAsset).to.equal(SUSD_PROXY);

        // check owner
        const actualOwner = await marginAccount.connect(account0).owner();
        expect(owner).to.equal(actualOwner);
        expect(actualOwner).to.equal(account0.address);
    });

    it("Should Approve Allowance and Deposit Margin into Account", async () => {
        // approve allowance for marginAccount to spend
        await sUSD
            .connect(account0)
            .approve(marginAccount.address, ACCOUNT_AMOUNT);

        // confirm allowance
        const allowance = await sUSD.allowance(
            account0.address,
            marginAccount.address
        );
        expect(allowance).to.equal(ACCOUNT_AMOUNT);

        // deposit (amount in wei == $10_000 sUSD) sUSD into margin account
        await marginAccount.connect(account0).deposit(ACCOUNT_AMOUNT);

        // confirm deposit
        const balance = await sUSD.balanceOf(marginAccount.address);
        expect(balance).to.equal(ACCOUNT_AMOUNT);
    });

    /**
     * For the following tests, the approximated leverage (1x, 3x, 5x, etc)
     * is not crucial. I added the approximations just for clarity. The
     * token prices at this current block (9000000) I only estimated.
     *
     * What is important are the multiples which change when new or modified
     * positions are passed to the contract (i.e. did size/margin/etc change appropriately)
     * */

    it("Should Open Single Position", async () => {
        // define new positions
        const newPosition = [
            {
                // open ~1x LONG position in ETH-PERP Market
                marketKey: MARKET_KEY_sETH,
                marginDelta: TEST_VALUE, // $1_000 sUSD
                sizeDelta: ethers.BigNumber.from("500000000000000000"),
                isClosing: false, // position is active (i.e. not closed)
            },
        ];

        // execute trade
        await marginAccount.connect(account0).distributeMargin(newPosition);

        // confirm number of open positions that were defined above
        const numberOfActivePositions = await marginAccount
            .connect(account0)
            .getNumberOfActivePositions();
        expect(numberOfActivePositions).to.equal(1);

        // confirm correct position details: Market, Margin, Size
        // ETH
        const ETHposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sETH);
        expect(ETHposition.marketKey).to.equal(MARKET_KEY_sETH);
        expect(ETHposition.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(1).div(100)); // 1% fee
        expect(ETHposition.size).to.equal(ethers.BigNumber.from("500000000000000000")); // 0.5 ETH
    });

    it("Should Open Multiple Positions", async () => {
        // define new positions
        const newPositions = [
            {
                // open ~1x SHORT position in BTC-PERP Market
                marketKey: MARKET_KEY_sBTC,
                marginDelta: TEST_VALUE, // $1_000 sUSD
                sizeDelta: ethers.BigNumber.from("-30000000000000000"), // 0.03 BTC
                isClosing: false, // position is active (i.e. not closed)
            },
            {
                // open ~5x LONG position in LINK-PERP Market
                marketKey: MARKET_KEY_sLINK,
                marginDelta: TEST_VALUE, // $1_000 sUSD
                sizeDelta: ethers.BigNumber.from("700000000000000000000"), // 700 LINK
                isClosing: false, // position is active (i.e. not closed)
            },
            {
                // open ~5x SHORT position in UNI-PERP Market
                marketKey: MARKET_KEY_sUNI,
                marginDelta: TEST_VALUE, // $1_000 sUSD
                sizeDelta: ethers.BigNumber.from("-900000000000000000000"), // 900 UNI
                isClosing: false, // position is active (i.e. not closed)
            },
        ];

        // execute trades
        await marginAccount.connect(account0).distributeMargin(newPositions);

        // confirm number of open positions
        const numberOfActivePositions = await marginAccount
            .connect(account0)
            .getNumberOfActivePositions();
        expect(numberOfActivePositions).to.equal(4);

        // confirm correct position details: Market, Margin, Size
        // BTC
        const BTCposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sBTC);
        expect(BTCposition.marketKey).to.equal(MARKET_KEY_sBTC);
        expect(BTCposition.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(1).div(100)); // 1% fee
        expect(BTCposition.size).to.equal(ethers.BigNumber.from("-30000000000000000")); // 0.03 BTC
        // LINK
        const LINKposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sLINK);
        expect(LINKposition.marketKey).to.equal(MARKET_KEY_sLINK);
        expect(LINKposition.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(2).div(100)); // 2% fee
        expect(LINKposition.size).to.equal(ethers.BigNumber.from("700000000000000000000")); // 700 LINK
        // UNI
        const UNIposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sUNI);
        expect(UNIposition.marketKey).to.equal(MARKET_KEY_sUNI);
        expect(UNIposition.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(2).div(100)); // 2% fee
        expect(UNIposition.size).to.equal(ethers.BigNumber.from("-900000000000000000000")); // 900 UNI
    });

    it("Should Modify Multiple Position's Size", async () => {
        /**
         * Notice that marginDelta for all positions is 0.
         * No withdrawing nor depositing into market positions, only
         * modifying position size (i.e. leverage)
         */

        // define new positions (modify existing)
        const newPositions = [
            {
                // modify ~1x LONG position in ETH-PERP Market to ~3x
                marketKey: MARKET_KEY_sETH,
                marginDelta: 0, // no deposit
                sizeDelta: ethers.BigNumber.from("1000000000000000000"), // 0.5 ETH -> 1.5 ETH
                isClosing: false, // position is active (i.e. not closed)
            },
            {
                // modify ~1x SHORT position in BTC-PERP Market to ~3x
                marketKey: MARKET_KEY_sBTC,
                marginDelta: 0, // no deposit
                sizeDelta: ethers.BigNumber.from("-60000000000000000"), // 0.03 BTC -> 0.09 BTC
                isClosing: false, // position is active (i.e. not closed)
            },
            {
                // modify ~5x LONG position in LINK-PERP Market to ~1x
                marketKey: MARKET_KEY_sLINK,
                marginDelta: 0, // no deposit
                sizeDelta: ethers.BigNumber.from("-560000000000000000000"), // 700 LINK -> 140 LINK
                isClosing: false, // position is active (i.e. not closed)
            },
            {
                // modify ~5x SHORT position in UNI-PERP Market to ~1x
                marketKey: MARKET_KEY_sUNI,
                marginDelta: 0, // no deposit
                sizeDelta: ethers.BigNumber.from("720000000000000000000"), // 900 UNI -> 180 UNI
                isClosing: false, // position is active (i.e. not closed)
            },
        ];

        // execute trades
        await marginAccount.connect(account0).distributeMargin(newPositions);

        // confirm number of open positions
        const numberOfActivePositions = await marginAccount
            .connect(account0)
            .getNumberOfActivePositions();
        expect(numberOfActivePositions).to.equal(4);

        // NOTICE: margin in each market position should stay *close* to the same 
        // (only decreasing slightly due to further fees for altering the position)

        // confirm correct position details: Market, Margin, Size
        // ETH
        const ETHposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sETH);
        expect(ETHposition.marketKey).to.equal(MARKET_KEY_sETH);
        expect(ETHposition.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(1).div(100));
        expect(ETHposition.size).to.equal(ethers.BigNumber.from("1500000000000000000"));
        // BTC
        const BTCposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sBTC);
        expect(BTCposition.marketKey).to.equal(MARKET_KEY_sBTC);
        expect(BTCposition.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(1).div(100)); // 1% fee
        expect(BTCposition.size).to.equal(ethers.BigNumber.from("-90000000000000000")); // 0.09 BTC
        // LINK
        const LINKposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sLINK);
        expect(LINKposition.marketKey).to.equal(MARKET_KEY_sLINK);
        expect(LINKposition.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(4).div(100)); // 4% fee
        expect(LINKposition.size).to.equal(ethers.BigNumber.from("140000000000000000000")); // 140 LINK
        // UNI
        const UNIposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sUNI);
        expect(UNIposition.marketKey).to.equal(MARKET_KEY_sUNI);
        expect(UNIposition.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(4).div(100)); // 4% fee
        expect(UNIposition.size).to.equal(ethers.BigNumber.from("-180000000000000000000")); // 180 UNI
    });

    it("Should Modify Multiple Position's Margin (deposit)", async () => {
        /**
         * BaseMargin Account at this point is only utilizing $4_000 sUSD of the
         * total $10_000 sUSD. The following trades will deposit more margin
         * into each active position, but will not alter the size
         */

        // confirm above assertion
        const expectedBalance = ethers.BigNumber.from("6000000000000000000000"); // $6_000 sUSD
        const actualbalance = await sUSD.balanceOf(marginAccount.address);
        expect(expectedBalance).to.equal(actualbalance);

        // define new positions (modify existing)
        const newPositions = [
            {
                // modify margin in position via $1_000 sUSD deposit
                marketKey: MARKET_KEY_sETH,
                marginDelta: TEST_VALUE, // $1_000 sUSD -> $2_000 sUSD
                sizeDelta: 0, // (no change) prev set to: 1.5 ETH
                isClosing: false, // position is active (i.e. not closed)
            },
            {
                // modify margin in position via $1_000 sUSD deposit
                marketKey: MARKET_KEY_sBTC,
                marginDelta: TEST_VALUE, // $1_000 sUSD -> $2_000 sUSD
                sizeDelta: 0, // (no change) prev set to: 0.09 BTC
                isClosing: false, // position is active (i.e. not closed)
            },
            {
                // modify margin in position via $1_000 sUSD deposit
                marketKey: MARKET_KEY_sLINK,
                marginDelta: TEST_VALUE, // $1_000 sUSD -> $2_000 sUSD
                sizeDelta: 0, // (no change) prev set to: 140 LINK
                isClosing: false, // position is active (i.e. not closed)
            },
            {
                // modify margin in position via $1_000 sUSD deposit
                marketKey: MARKET_KEY_sUNI,
                marginDelta: TEST_VALUE, // $1_000 sUSD -> $2_000 sUSD
                sizeDelta: 0, // (no change) prev set to: 180 UNI
                isClosing: false, // position is active (i.e. not closed)
            },
        ];

        // execute trades
        await marginAccount.connect(account0).distributeMargin(newPositions);

        // confirm number of open positions
        const numberOfActivePositions = await marginAccount
            .connect(account0)
            .getNumberOfActivePositions();
        expect(numberOfActivePositions).to.equal(4);

        // NOTICE: margin in each market position should stay *close* to the same 
        // (only decreasing slightly due to further fees for altering the position)

        // confirm correct position details: Market, Margin, Size
        // ETH
        const ETHposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sETH);
        expect(ETHposition.marketKey).to.equal(MARKET_KEY_sETH);
        expect(ETHposition.margin).to.be.closeTo(TEST_VALUE.add(TEST_VALUE), TEST_VALUE.mul(1).div(100));
        expect(ETHposition.size).to.equal(ethers.BigNumber.from("1500000000000000000"));
        // BTC
        const BTCposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sBTC);
        expect(BTCposition.marketKey).to.equal(MARKET_KEY_sBTC);
        expect(BTCposition.margin).to.be.closeTo(TEST_VALUE.add(TEST_VALUE), TEST_VALUE.mul(1).div(100)); // 1% fee
        expect(BTCposition.size).to.equal(ethers.BigNumber.from("-90000000000000000")); // 0.09 BTC
        // LINK
        const LINKposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sLINK);
        expect(LINKposition.marketKey).to.equal(MARKET_KEY_sLINK);
        expect(LINKposition.margin).to.be.closeTo(TEST_VALUE.add(TEST_VALUE), TEST_VALUE.mul(4).div(100)); // 4% fee
        expect(LINKposition.size).to.equal(ethers.BigNumber.from("140000000000000000000")); // 140 LINK
        // UNI
        const UNIposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sUNI);
        expect(UNIposition.marketKey).to.equal(MARKET_KEY_sUNI);
        expect(UNIposition.margin).to.be.closeTo(TEST_VALUE.add(TEST_VALUE), TEST_VALUE.mul(4).div(100)); // 4% fee
        expect(UNIposition.size).to.equal(ethers.BigNumber.from("-180000000000000000000")); // 180 UNI
    });

    it("Should Modify Multiple Position's Margin (withdraw)", async () => {
        /**
         * BaseMargin Account at this point is only utilizing $8_000 sUSD of the
         * total $10_000 sUSD. The following trades will withdraw margin
         * from each active position, but will not alter the size
         */

        // confirm above assertion
        const expectedBalance = ethers.BigNumber.from("2000000000000000000000"); // $2_000 sUSD
        const actualbalance = await sUSD.balanceOf(marginAccount.address);
        expect(expectedBalance).to.equal(actualbalance);

        // define new positions (modify existing)
        const newPositions = [
            {
                // modify margin in position via $1_000 sUSD withdraw
                marketKey: MARKET_KEY_sETH,
                marginDelta: TEST_VALUE.mul(-1), // $2_000 sUSD -> $1_000 sUSD
                sizeDelta: 0, // (no change) prev set to: 1.5 ETH
                isClosing: false, // position is active (i.e. not closed)
            },
            {
                // modify margin in position via $1_000 sUSD withdraw
                marketKey: MARKET_KEY_sBTC,
                marginDelta: TEST_VALUE.mul(-1), // $2_000 sUSD -> $1_000 sUSD
                sizeDelta: 0, // (no change) prev set to: 0.09 BTC
                isClosing: false, // position is active (i.e. not closed)
            },
            {
                // modify margin in position via $1_000 sUSD withdraw
                marketKey: MARKET_KEY_sLINK,
                marginDelta: TEST_VALUE.mul(-1), // $2_000 sUSD -> $1_000 sUSD
                sizeDelta: 0, // (no change) prev set to: 140 LINK
                isClosing: false, // position is active (i.e. not closed)
            },
            {
                // modify margin in position via $1_000 sUSD withdraw
                marketKey: MARKET_KEY_sUNI,
                marginDelta: TEST_VALUE.mul(-1), // $2_000 sUSD -> $1_000 sUSD
                sizeDelta: 0, // (no change) prev set to: 180 UNI
                isClosing: false, // position is active (i.e. not closed)
            },
        ];

        // execute trades
        await marginAccount.connect(account0).distributeMargin(newPositions);

        // confirm number of open positions
        const numberOfActivePositions = await marginAccount
            .connect(account0)
            .getNumberOfActivePositions();
        expect(numberOfActivePositions).to.equal(4);

        // NOTICE: margin in each market position should stay *close* to the same 
        // (only decreasing slightly due to further fees for altering the position)

        // confirm correct position details: Market, Margin, Size
        // ETH
        const position = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sETH);
        expect(position.marketKey).to.equal(MARKET_KEY_sETH);
        expect(position.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(1).div(100));
        expect(position.size).to.equal(ethers.BigNumber.from("1500000000000000000"));
        // BTC
        const BTCposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sBTC);
        expect(BTCposition.marketKey).to.equal(MARKET_KEY_sBTC);
        expect(BTCposition.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(1).div(100)); // 1% fee
        expect(BTCposition.size).to.equal(ethers.BigNumber.from("-90000000000000000")); // 0.09 BTC
        // LINK
        const LINKposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sLINK);
        expect(LINKposition.marketKey).to.equal(MARKET_KEY_sLINK);
        expect(LINKposition.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(4).div(100)); // 4% fee
        expect(LINKposition.size).to.equal(ethers.BigNumber.from("140000000000000000000")); // 140 LINK
        // UNI
        const UNIposition = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sUNI);
        expect(UNIposition.marketKey).to.equal(MARKET_KEY_sUNI);
        expect(UNIposition.margin).to.be.closeTo(TEST_VALUE, TEST_VALUE.mul(4).div(100)); // 4% fee
        expect(UNIposition.size).to.equal(ethers.BigNumber.from("-180000000000000000000")); // 180 UNI
    });

    it("Should have Withdrawn Margin back to Account", async () => {
        /**
         * Above test withdrew margin (TEST_VALUE) from each (4) position.
         * Given that, the account should now have:
         * $2_000 sUSD (never used) + $4_000 sUSD (just withdrawn) = $6_000 sUSD
         */
        const expectedBalance = ethers.BigNumber.from("6000000000000000000000"); // $6_000 sUSD
        const actualbalance = await sUSD.balanceOf(marginAccount.address);
        expect(expectedBalance).to.equal(actualbalance);
    });

    it("Should Exit Position by Setting Size to Zero", async () => {
        // establish ETH position
        let position = await marginAccount.connect(account0).activeMarketPositions(MARKET_KEY_sETH);

        // define new positions (modify existing)
        const newPositions = [
            {
                // modify size in position to 0
                marketKey: MARKET_KEY_sETH,
                marginDelta: 0,
                sizeDelta: (position.size).mul(-1), // opposite size
                isClosing: false, // position is active (i.e. not closed)
            }
        ];

        // execute trades
        await marginAccount.connect(account0).distributeMargin(newPositions);

        // confirm number of open positions
        const numberOfActivePositions = await marginAccount
            .connect(account0)
            .getNumberOfActivePositions();
        expect(numberOfActivePositions).to.equal(3);
    });

    it("Should Exit One Position with isClosing", async () => {
        // define new positions (modify existing)
        const newPositions = [
            {
                // exit position
                marketKey: MARKET_KEY_sBTC,
                marginDelta: 0,
                sizeDelta: 0, 
                isClosing: true, // position should be closed
            },
        ];

        // execute trades
        await marginAccount.connect(account0).distributeMargin(newPositions);

        // confirm number of open positions
        const numberOfActivePositions = await marginAccount
            .connect(account0)
            .getNumberOfActivePositions();
        expect(numberOfActivePositions).to.equal(2);
    });

    it("Should Exit all Positions with isClosing", async () => {
        // define new positions (modify existing)
        const newPositions = [
            {
                // exit position
                marketKey: MARKET_KEY_sLINK,
                marginDelta: 0,
                sizeDelta: 0, 
                isClosing: true, // position should be closed
            },
            {
                // exit position
                marketKey: MARKET_KEY_sUNI,
                marginDelta: 0, 
                sizeDelta: 0, 
                isClosing: true, // position should be closed
            },
        ];

        // execute trades
        await marginAccount.connect(account0).distributeMargin(newPositions);

        // confirm number of open positions
        const numberOfActivePositions = await marginAccount
            .connect(account0)
            .getNumberOfActivePositions();
        expect(numberOfActivePositions).to.equal(0);
    });

    it("Should have Withdrawn all Margin back to Account", async () => {
        /**
         * Above test closed and withdrew ALL margin from each (4) position.
         * Given that, the account should now have:
         * $10_000 sUSD minus fees
         */
        const expectedBalance = ethers.BigNumber.from("10000000000000000000000"); // $10_000 sUSD
        const actualbalance = await sUSD.balanceOf(marginAccount.address);
        expect(expectedBalance).to.be.closeTo(actualbalance, expectedBalance.mul(5).div(100)); // 5% fees
    });

    it("Should Withdraw Margin from Account", async () => {
        // get account balance
        const accountBalance = await sUSD.balanceOf(marginAccount.address);

        // withdraw sUSD from margin account
        await marginAccount.connect(account0).withdraw(accountBalance);

        // confirm withdraw
        const eoaBalance = await sUSD.balanceOf(account0.address);

        // fees resulted in:
        // ACCOUNT_AMOUNT (initial margin amount depositied into account) > accountBalance 
        expect(eoaBalance).to.equal(MINT_AMOUNT.sub(ACCOUNT_AMOUNT).add(accountBalance));
    });
});
