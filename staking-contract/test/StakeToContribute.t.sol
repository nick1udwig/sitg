// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StakeToContribute} from "../src/StakeToContribute.sol";

address constant HEVM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function deal(address who, uint256 newBalance) external;
    function warp(uint256) external;
}

contract StakeToContributeTest {
    Vm internal constant vm = Vm(HEVM_ADDRESS);

    uint256 internal constant LOCK_DURATION = 30 days;
    StakeToContribute internal staking;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

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
        vm.expectRevert(StakeToContribute.AmountZero.selector);
        staking.stake{value: 0}();
    }

    function testStakeSetsBalanceAndUnlockTime() public {
        uint256 beforeTs = block.timestamp;

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

    function testWithdrawRequiresPositiveAmount() public {
        vm.prank(alice);
        vm.expectRevert(StakeToContribute.AmountZero.selector);
        staking.withdraw(0);
    }

    function testWithdrawRequiresSufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(StakeToContribute.InsufficientBalance.selector);
        staking.withdraw(1 wei);
    }

    function testWithdrawBlockedWhileLocked() public {
        vm.prank(alice);
        staking.stake{value: 1 ether}();

        vm.prank(alice);
        vm.expectRevert(StakeToContribute.LockActive.selector);
        staking.withdraw(1 wei);
    }

    function testWithdrawSucceedsAfterUnlock() public {
        vm.prank(alice);
        staking.stake{value: 3 ether}();

        uint256 unlockTs = staking.unlockTime(alice);
        vm.warp(unlockTs);

        uint256 aliceBalanceBefore = alice.balance;

        vm.prank(alice);
        staking.withdraw(1 ether);

        assertEq(staking.stakedBalance(alice), 2 ether, "remaining stake mismatch");
        assertEq(alice.balance, aliceBalanceBefore + 1 ether, "withdraw transfer mismatch");
    }

    function testWithdrawAllClearsActiveStake() public {
        vm.prank(alice);
        staking.stake{value: 2 ether}();

        uint256 unlockTs = staking.unlockTime(alice);
        vm.warp(unlockTs);

        vm.prank(alice);
        staking.withdraw(2 ether);

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

    function testIsStakeActiveAtBoundary() public {
        vm.prank(alice);
        staking.stake{value: 1 ether}();

        uint256 unlockTs = staking.unlockTime(alice);
        vm.warp(unlockTs - 1);
        assertTrue(staking.isStakeActive(alice), "active just before unlock");

        vm.warp(unlockTs);
        assertFalse(staking.isStakeActive(alice), "inactive at unlock timestamp");
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
}
