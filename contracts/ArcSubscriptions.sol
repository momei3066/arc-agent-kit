// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ArcSubscriptions
 * @author Pin Luo
 * @notice Trustless recurring USDC payments on Arc Network.
 *
 * Design: pre-funded escrow. Payer deposits native USDC (Arc's gas token)
 * into this contract, creates a subscription pointing at a recipient, and
 * the contract auto-disburses on each call to `charge(id)` once the
 * interval has elapsed. Anyone can crank `charge` — gas is paid by the
 * caller, so subscriptions keep running even if the payer's agent is
 * offline, as long as someone else has the incentive to call.
 *
 * Why escrow instead of approve/transferFrom: Arc's native-USDC precompile
 * at 0x3600...0000 exposes ERC-20 balanceOf, but `approve/transferFrom`
 * behavior is not formally guaranteed in current docs. Native-value
 * transfers ARE formally guaranteed. This design uses only native
 * transfers, so it's deployable today on Arc testnet without ABI risk.
 *
 * Safety:
 * - Payer can withdraw any unspent balance at any time (cancel-free exit)
 * - Each subscription belongs to one payer; nobody else can drain it
 * - Reentrancy: external transfer comes AFTER state updates (checks-effects-interactions)
 * - Minimum 60s interval (matches the off-chain scheduler's guardrail)
 *
 * Not in scope (deliberately): on-chain price feeds, multi-token support,
 * delegated cancellation, governance. Keep this primitive small and
 * obvious; the off-chain agent layer composes richer behavior on top.
 */
contract ArcSubscriptions {
    struct Subscription {
        address payer;
        address recipient;
        uint256 amountWei;        // amount per tick in native USDC wei (18 decimals on Arc)
        uint256 intervalSeconds;
        uint256 lastChargedAt;    // unix seconds of last successful charge
        uint256 ticks;            // number of times this subscription has fired
        bool active;
    }

    mapping(uint256 => Subscription) public subscriptions;
    mapping(address => uint256) public balances;  // payer -> escrowed USDC wei
    uint256 public nextId;

    event Deposit(address indexed payer, uint256 amountWei, uint256 newBalance);
    event Withdrawal(address indexed payer, uint256 amountWei, uint256 newBalance);
    event SubscriptionCreated(
        uint256 indexed id,
        address indexed payer,
        address indexed recipient,
        uint256 amountWei,
        uint256 intervalSeconds
    );
    event SubscriptionCharged(uint256 indexed id, uint256 amountWei, uint256 newTicks);
    event SubscriptionCancelled(uint256 indexed id);

    error InvalidRecipient();
    error InvalidAmount();
    error IntervalTooShort();
    error NotPayer();
    error SubscriptionInactive();
    error NotDueYet();
    error InsufficientBalance();
    error WithdrawFailed();
    error TransferFailed();

    /// Deposit native USDC into this payer's escrow balance.
    /// Use this before (or alongside) creating subscriptions.
    receive() external payable {
        balances[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value, balances[msg.sender]);
    }

    /// Withdraw unspent native USDC from this payer's escrow balance.
    function withdraw(uint256 amountWei) external {
        if (balances[msg.sender] < amountWei) revert InsufficientBalance();
        balances[msg.sender] -= amountWei;
        (bool ok, ) = msg.sender.call{value: amountWei}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawal(msg.sender, amountWei, balances[msg.sender]);
    }

    /**
     * Create a subscription. The subscription is "due immediately" — the
     * first `charge` call after creation will fire as long as the payer
     * has enough escrow balance.
     */
    function createSubscription(
        address recipient,
        uint256 amountWei,
        uint256 intervalSeconds
    ) external returns (uint256 id) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (amountWei == 0) revert InvalidAmount();
        if (intervalSeconds < 60) revert IntervalTooShort();
        unchecked {
            id = ++nextId;
        }
        subscriptions[id] = Subscription({
            payer: msg.sender,
            recipient: recipient,
            amountWei: amountWei,
            intervalSeconds: intervalSeconds,
            // start lastChargedAt at `now - interval` so it's due immediately
            lastChargedAt: block.timestamp > intervalSeconds
                ? block.timestamp - intervalSeconds
                : 0,
            ticks: 0,
            active: true
        });
        emit SubscriptionCreated(id, msg.sender, recipient, amountWei, intervalSeconds);
    }

    /**
     * Fire a subscription charge if it's due. Anyone can call this — the
     * incentive is that the caller pays gas in USDC to move payer's USDC
     * to recipient (i.e. a crank service can profit from a separate
     * arrangement, or the recipient cranks for themselves).
     */
    function charge(uint256 id) external {
        Subscription storage s = subscriptions[id];
        if (!s.active) revert SubscriptionInactive();
        if (block.timestamp < s.lastChargedAt + s.intervalSeconds) revert NotDueYet();
        if (balances[s.payer] < s.amountWei) revert InsufficientBalance();

        // checks-effects-interactions: update state before external call.
        s.lastChargedAt = block.timestamp;
        unchecked {
            s.ticks += 1;
        }
        balances[s.payer] -= s.amountWei;

        (bool ok, ) = s.recipient.call{value: s.amountWei}("");
        if (!ok) revert TransferFailed();

        emit SubscriptionCharged(id, s.amountWei, s.ticks);
    }

    /// Payer cancels their own subscription. Balance stays in escrow until withdrawn.
    function cancel(uint256 id) external {
        Subscription storage s = subscriptions[id];
        if (s.payer != msg.sender) revert NotPayer();
        s.active = false;
        emit SubscriptionCancelled(id);
    }

    /// View: would `charge(id)` succeed right now? Useful for off-chain cranking.
    function isDue(uint256 id) external view returns (bool) {
        Subscription storage s = subscriptions[id];
        return
            s.active &&
            block.timestamp >= s.lastChargedAt + s.intervalSeconds &&
            balances[s.payer] >= s.amountWei;
    }
}
