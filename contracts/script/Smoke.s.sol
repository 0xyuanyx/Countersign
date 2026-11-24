// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EvidenceRegistry} from "../src/EvidenceRegistry.sol";

/// @notice 테스트넷 전용 연기 테스트: 에이전트 #1 등록 → 그 에이전트가 서명한 EIP-3009 증거 1건 기록.
///  결제는 실제로 일어나지 않는다 (payTxHash는 "smoke" 표시값). 메인넷에서는 돌지 않는다.
contract Smoke is Script {
    function run() external {
        require(block.chainid != 177, "testnet only");
        EvidenceRegistry reg = EvidenceRegistry(vm.envAddress("REGISTRY"));
        string memory m = vm.envString("OURYN_DEV_MNEMONIC");
        uint256 ownerPk = vm.deriveKey(m, 0);
        uint256 agentPk = vm.deriveKey(m, 1);
        address agent = vm.addr(agentPk);

        EvidenceRegistry.Authorization memory a = EvidenceRegistry.Authorization({
            token: 0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6,
            payChainId: 133,
            name: "USD Coin",
            version: "2",
            from: agent,
            to: 0x000000000000000000000000000000000000dEaD,
            value: 100_000,
            validAfter: 0,
            validBefore: block.timestamp + 300,
            nonce: keccak256(abi.encode("countersign-smoke", block.timestamp))
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, reg.hashAuthorization(a));

        vm.startBroadcast(ownerPk);
        if (reg.policyHashOf(agent) == bytes32(0)) reg.registerAgent(agent, keccak256("countersign-smoke-policy"));
        bytes32 digest = reg.record(keccak256(abi.encode("smoke-order", block.timestamp)), a, abi.encodePacked(r, s, v), keccak256("smoke"));
        vm.stopBroadcast();
        console.log("agent", agent);
        console.logBytes32(digest);
    }
}
