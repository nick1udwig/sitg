// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SITGStaking} from "../src/SITGStaking.sol";

address constant HEVM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));

interface Vm {
    function envUint(string calldata key) external returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeploySITGStakingScript {
    Vm internal constant vm = Vm(HEVM_ADDRESS);

    function run() external returns (SITGStaking deployed) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);
        deployed = new SITGStaking();
        vm.stopBroadcast();
    }
}
