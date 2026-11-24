// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EvidenceRegistry} from "../src/EvidenceRegistry.sol";

/// @notice EvidenceRegistry 배포. 키는 script/deploy.sh가 맥 키체인에서 환경변수로만 넘긴다.
///  - 테스트넷(133): OURYN_DEV_MNEMONIC 0번 계정 (0x0BcB…3ecF)
///  - 메인넷(177):   OURYN_DEPLOYER_KEY (0x6842…b114). **실행은 태민만.**
///  체인과 키가 엇갈리면(메인넷에 개발 키, 테스트넷에 메인넷 키) 멈춘다.
contract Deploy is Script {
    uint256 constant HSK_MAINNET = 177;

    function run() external returns (EvidenceRegistry reg) {
        uint256 pk;
        if (block.chainid == HSK_MAINNET) {
            pk = vm.envUint("OURYN_DEPLOYER_KEY");
            require(bytes(vm.envOr("OURYN_DEV_MNEMONIC", string(""))).length == 0, "mainnet: dev mnemonic must not be set");
        } else {
            require(vm.envOr("OURYN_DEPLOYER_KEY", uint256(0)) == 0, "testnet: mainnet key must not be set");
            pk = vm.deriveKey(vm.envString("OURYN_DEV_MNEMONIC"), 0); // m/44'/60'/0'/0/0
        }
        address deployer = vm.addr(pk);
        address owner = vm.envOr("REGISTRY_OWNER", deployer);
        console.log("chain", block.chainid);
        console.log("deployer", deployer);
        console.log("owner", owner);

        vm.startBroadcast(pk);
        reg = new EvidenceRegistry(owner);
        vm.stopBroadcast();
        console.log("EvidenceRegistry", address(reg));
    }
}
