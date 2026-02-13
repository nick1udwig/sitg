// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StakeToContribute} from "../src/StakeToContribute.sol";
import {IStakeToContribute} from "../src/IStakeToContribute.sol";

address constant HEVM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool, address) external;
    function deal(address who, uint256 newBalance) external;
    function warp(uint256) external;
}

contract StakeToContributeTest {
    Vm internal constant vm = Vm(HEVM_ADDRESS);

    uint256 internal constant LOCK_DURATION = 30 days;
    StakeToContribute internal staking;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal mallory = address(0xBEEF);

    event Staked(address indexed user, uint256 amountAdded, uint256 newBalance, uint256 unlockTime);
    event Withdrawn(address indexed user, uint256 amountWithdrawn);

    function setUp() public {
        staking = new StakeToContribute();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function testLockDurationConfigured() public view {
        assertEq(staking.lockDuration(), LOCK_DURATION, "lockDuration mismatch");
    }

    function testStakeRequiresValue() public {
        vm.prank(alice);
        vm.expectRevert(IStakeToContribute.AmountZero.selector);
        staking.stake{value: 0}();
    }

    function testStakeAllowsZeroIfAlreadyStaked() public {
        vm.prank(alice);
        staking.stake{value: 1 ether}();

        uint256 firstUnlock = staking.unlockTime(alice);
        vm.warp(block.timestamp + 1 days);
        uint256 secondTs = block.timestamp;

        vm.expectEmit(true, true, true, true, address(staking));
        emit Staked(alice, 0, 1 ether, secondTs + LOCK_DURATION);
        vm.prank(alice);
        staking.stake{value: 0}();

        assertEq(staking.stakedBalance(alice), 1 ether, "balance should stay unchanged");
        assertTrue(staking.unlockTime(alice) > firstUnlock, "unlock should move forward");
        assertEq(staking.unlockTime(alice), secondTs + LOCK_DURATION, "unlock should reset to now + duration");
    }

    function testStakeSetsBalanceAndUnlockTime() public {
        uint256 beforeTs = block.timestamp;

        vm.expectEmit(true, true, true, true, address(staking));
        emit Staked(alice, 2 ether, 2 ether, beforeTs + LOCK_DURATION);
        vm.prank(alice);
        staking.stake{value: 2 ether}();

        assertEq(staking.stakedBalance(alice), 2 ether, "balance mismatch");
        assertEq(staking.unlockTime(alice), beforeTs + LOCK_DURATION, "unlockTime mismatch");
        assertTrue(staking.isStakeActive(alice), "stake should be active");
    }

    function testStakeResetsUnlockTimeForExistingStaker() public {
        uint256 firstTs = block.timestamp;

        vm.prank(alice);
        staking.stake{value: 1 ether}();

        vm.warp(firstTs + 3 days);
        uint256 secondTs = block.timestamp;

        vm.prank(alice);
        staking.stake{value: 1 ether}();

        assertEq(staking.stakedBalance(alice), 2 ether, "stacked balance mismatch");
        assertEq(staking.unlockTime(alice), secondTs + LOCK_DURATION, "unlockTime should reset");
    }

    function testWithdrawRequiresExistingStake() public {
        vm.prank(alice);
        vm.expectRevert(IStakeToContribute.InsufficientBalance.selector);
        staking.withdraw();
    }

    function testWithdrawBlockedWhileLocked() public {
        vm.prank(alice);
        staking.stake{value: 1 ether}();

        vm.prank(alice);
        vm.expectRevert(IStakeToContribute.LockActive.selector);
        staking.withdraw();
    }

    function testWithdrawSucceedsAfterUnlock() public {
        vm.prank(alice);
        staking.stake{value: 3 ether}();

        uint256 unlockTs = staking.unlockTime(alice);
        vm.warp(unlockTs);

        uint256 aliceBalanceBefore = alice.balance;

        vm.expectEmit(true, true, false, false, address(staking));
        emit Withdrawn(alice, 3 ether);
        vm.prank(alice);
        staking.withdraw();

        assertEq(staking.stakedBalance(alice), 0, "remaining stake mismatch");
        assertEq(staking.unlockTime(alice), 0, "unlock time should clear");
        assertEq(alice.balance, aliceBalanceBefore + 3 ether, "withdraw transfer mismatch");
    }

    function testWithdrawAllClearsActiveStake() public {
        vm.prank(alice);
        staking.stake{value: 2 ether}();

        uint256 unlockTs = staking.unlockTime(alice);
        vm.warp(unlockTs);

        vm.prank(alice);
        staking.withdraw();

        assertEq(staking.stakedBalance(alice), 0, "balance should be zero");
        assertFalse(staking.isStakeActive(alice), "zero balance should be inactive");
    }

    function testStakeStateIsIndependentPerUser() public {
        vm.prank(alice);
        staking.stake{value: 1 ether}();

        vm.prank(bob);
        staking.stake{value: 4 ether}();

        assertEq(staking.stakedBalance(alice), 1 ether, "alice balance mismatch");
        assertEq(staking.stakedBalance(bob), 4 ether, "bob balance mismatch");
        assertTrue(staking.unlockTime(alice) > 0, "alice unlock missing");
        assertTrue(staking.unlockTime(bob) > 0, "bob unlock missing");
    }

    function testCannotWithdrawAnotherUsersStake() public {
        vm.prank(alice);
        staking.stake{value: 1 ether}();

        vm.prank(bob);
        vm.expectRevert(IStakeToContribute.InsufficientBalance.selector);
        staking.withdraw();
    }

    function testNewUserHasZeroState() public view {
        assertEq(staking.stakedBalance(bob), 0, "new user balance should be zero");
        assertEq(staking.unlockTime(bob), 0, "new user unlock should be zero");
        assertFalse(staking.isStakeActive(bob), "new user should be inactive");
    }

    function testIsStakeActiveAtBoundary() public {
        vm.prank(alice);
        staking.stake{value: 1 ether}();

        uint256 unlockTs = staking.unlockTime(alice);
        vm.warp(unlockTs - 1);
        assertTrue(staking.isStakeActive(alice), "active just before unlock");

        vm.warp(unlockTs);
        assertFalse(staking.isStakeActive(alice), "inactive at unlock timestamp");
    }

    function testFuzzStakeAddsValueAndResetsUnlock(uint96 amountWei, uint32 warpBy) public {
        uint256 amount = uint256(amountWei % 10 ether);
        if (amount == 0) amount = 1;
        uint256 warpSeconds = uint256(warpBy % uint32(LOCK_DURATION - 1));

        vm.prank(alice);
        staking.stake{value: amount}();

        vm.warp(block.timestamp + warpSeconds);
        uint256 currentTs = block.timestamp;

        vm.prank(alice);
        staking.stake{value: amount}();

        assertEq(staking.stakedBalance(alice), amount * 2, "fuzz balance mismatch");
        assertEq(staking.unlockTime(alice), currentTs + LOCK_DURATION, "fuzz unlock reset mismatch");
    }

    function testFuzzWithdrawAfterUnlockWithdrawsAll(uint96 amountWei) public {
        uint256 amount = uint256(amountWei % 25 ether);
        if (amount == 0) amount = 1;

        vm.prank(alice);
        staking.stake{value: amount}();

        vm.warp(staking.unlockTime(alice));
        uint256 beforeBal = alice.balance;

        vm.prank(alice);
        staking.withdraw();

        assertEq(staking.stakedBalance(alice), 0, "fuzz withdraw should clear balance");
        assertEq(staking.unlockTime(alice), 0, "fuzz withdraw should clear unlock");
        assertEq(alice.balance, beforeBal + amount, "fuzz withdraw amount mismatch");
    }

    function testReentrancyAttemptOnWithdrawDoesNotDrainMore() public {
        ReentrancyReceiver attacker = new ReentrancyReceiver(staking);
        vm.deal(mallory, 5 ether);

        vm.prank(mallory);
        attacker.stakeOnTarget{value: 1 ether}();

        vm.warp(staking.unlockTime(address(attacker)));
        uint256 before = address(attacker).balance;

        vm.prank(mallory);
        attacker.withdrawFromTarget();

        assertEq(staking.stakedBalance(address(attacker)), 0, "attacker stake should be zero");
        assertEq(address(attacker).balance, before + 1 ether, "attacker should receive exactly staked amount");
        assertTrue(attacker.reentryAttempted(), "reentry should have been attempted");
        assertEq(
            uint256(uint32(attacker.reentryRevertSelector())),
            uint256(uint32(IStakeToContribute.InsufficientBalance.selector)),
            "reentry should fail with insufficient balance"
        );
    }

    function testWithdrawToAllowsRecoveryForNonPayableStaker() public {
        RejectingReceiver stuck = new RejectingReceiver(staking);
        vm.deal(mallory, 5 ether);

        vm.prank(mallory);
        stuck.stakeOnTarget{value: 1 ether}();

        uint256 unlockTs = staking.unlockTime(address(stuck));
        vm.warp(unlockTs);
        uint256 aliceBefore = alice.balance;

        vm.prank(mallory);
        stuck.withdrawToFromTarget(payable(alice));

        assertEq(staking.stakedBalance(address(stuck)), 0, "stake should clear after withdrawTo");
        assertEq(staking.unlockTime(address(stuck)), 0, "unlock should clear after withdrawTo");
        assertEq(alice.balance, aliceBefore + 1 ether, "recipient should receive full withdrawn amount");
    }

    function testForcedEthIsTrackedAsExcessBalance() public {
        vm.prank(alice);
        staking.stake{value: 2 ether}();
        vm.prank(bob);
        staking.stake{value: 1 ether}();

        uint256 totalStakedBefore = readUintView(address(staking), "totalStaked()");
        uint256 excessBefore = readUintView(address(staking), "excessBalance()");

        assertEq(totalStakedBefore, 3 ether, "total staked precondition mismatch");
        assertEq(excessBefore, 0, "excess should be zero before forced ETH");

        ForceEtherSender injector = new ForceEtherSender{value: 1 ether}();
        injector.destroyAndSend(payable(address(staking)));

        uint256 totalStakedAfter = readUintView(address(staking), "totalStaked()");
        uint256 excessAfter = readUintView(address(staking), "excessBalance()");

        assertEq(totalStakedAfter, 3 ether, "forced ETH must not change tracked stake");
        assertEq(excessAfter, 1 ether, "forced ETH should appear as excess balance");
    }

    function testAccountingViewsRemainConsistentAfterWithdraw() public {
        vm.prank(alice);
        staking.stake{value: 2 ether}();
        vm.prank(bob);
        staking.stake{value: 1 ether}();

        ForceEtherSender injector = new ForceEtherSender{value: 2 ether}();
        injector.destroyAndSend(payable(address(staking)));

        vm.warp(staking.unlockTime(alice));
        vm.prank(alice);
        staking.withdraw();

        uint256 totalStakedAfter = readUintView(address(staking), "totalStaked()");
        uint256 excessAfter = readUintView(address(staking), "excessBalance()");

        assertEq(totalStakedAfter, 1 ether, "tracked stake should reduce after withdrawal");
        assertEq(excessAfter, 2 ether, "excess should remain unchanged by user withdrawal");
    }

    function assertEq(uint256 a, uint256 b, string memory err) internal pure {
        require(a == b, err);
    }

    function assertTrue(bool v, string memory err) internal pure {
        require(v, err);
    }

    function assertFalse(bool v, string memory err) internal pure {
        require(!v, err);
    }

    function readUintView(address target, string memory signature) internal view returns (uint256) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(signature));
        require(ok, "missing accounting view");
        return abi.decode(data, (uint256));
    }
}

contract ReentrancyReceiver {
    StakeToContribute internal immutable _staking;
    bool internal _attempted;
    bytes4 internal _selector;

    constructor(StakeToContribute staking_) {
        _staking = staking_;
    }

    receive() external payable {
        if (_attempted) return;
        _attempted = true;
        try _staking.withdraw() {
            _selector = bytes4(0);
        } catch (bytes memory reason) {
            if (reason.length >= 4) {
                _selector = bytes4(reason);
            }
        }
    }

    function stakeOnTarget() external payable {
        _staking.stake{value: msg.value}();
    }

    function withdrawFromTarget() external {
        _staking.withdraw();
    }

    function reentryAttempted() external view returns (bool) {
        return _attempted;
    }

    function reentryRevertSelector() external view returns (bytes4) {
        return _selector;
    }
}

contract RejectingReceiver {
    StakeToContribute internal immutable _staking;

    constructor(StakeToContribute staking_) {
        _staking = staking_;
    }

    receive() external payable {
        revert("reject ETH");
    }

    function stakeOnTarget() external payable {
        _staking.stake{value: msg.value}();
    }

    function withdrawFromTarget() external {
        _staking.withdraw();
    }

    function withdrawToFromTarget(address payable recipient) external {
        (bool ok, ) = address(_staking).call(abi.encodeWithSignature("withdrawTo(address)", recipient));
        require(ok, "withdrawTo failed");
    }
}

contract ForceEtherSender {
    constructor() payable {}

    function destroyAndSend(address payable target) external {
        selfdestruct(target);
    }
}
