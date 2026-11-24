// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EvidenceRegistry} from "../src/EvidenceRegistry.sol";

contract EvidenceRegistryTest is Test {
    EvidenceRegistry reg;
    address owner = makeAddr("owner");
    uint256 agentPk = 0xA11CE;
    address agent;
    address seller = makeAddr("seller");
    address usdc = 0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6;
    bytes32 constant ORDER = keccak256("order-1");
    bytes32 constant TX = keccak256("tx-1");
    bytes32 constant POLICY = keccak256("policy-v1");

    function setUp() public {
        reg = new EvidenceRegistry(owner);
        agent = vm.addr(agentPk);
        vm.prank(owner);
        reg.registerAgent(agent, POLICY);
    }

    function _auth() internal view returns (EvidenceRegistry.Authorization memory a) {
        a = EvidenceRegistry.Authorization({
            token: usdc,
            payChainId: 133,
            name: "USD Coin",
            version: "2",
            from: agent,
            to: seller,
            value: 100_000,
            validAfter: 0,
            validBefore: 1_800_000_300,
            nonce: bytes32(uint256(1))
        });
    }

    function _sign(uint256 pk, EvidenceRegistry.Authorization memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, reg.hashAuthorization(a));
        return abi.encodePacked(r, s, v);
    }

    function test_record() public {
        EvidenceRegistry.Authorization memory a = _auth();
        bytes memory sig = _sign(agentPk, a);
        bytes32 digest = reg.hashAuthorization(a);
        vm.expectEmit(address(reg));
        emit EvidenceRegistry.EvidenceRecorded(agent, ORDER, seller, digest, usdc, 100_000, 133, TX);
        vm.prank(owner);
        assertEq(reg.record(ORDER, a, sig, TX), digest);
        assertTrue(reg.recorded(ORDER));
    }

    /// viem(wallet-core/evidence.ts)으로 만든 digest·서명과 체인 위 계산이 같은지 (다른 구현 교차 확인)
    /// 공개 BIP-39 테스트 니모닉 "abandon … about" 1번 계정 = agent, 2번 = seller
    function test_matchesViemVector() public {
        address viemAgent = 0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0;
        EvidenceRegistry.Authorization memory a = _auth();
        a.from = viemAgent;
        a.to = 0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A;
        a.nonce = 0x1111111111111111111111111111111111111111111111111111111111111111;
        assertEq(reg.hashAuthorization(a), 0xa1548a28acff3038fdc22283e96b9d9d572472e1604bb38fe8863d2a4ab9f937);
        bytes memory sig =
            hex"ce99217a545a482b9c0597e275c021da5b85500fea603d2773c43724c26dd0390faf55ab51e74dddaad782245c37563dcf2318d412bb44da02ab93a9aa1cd6071c";
        vm.startPrank(owner);
        reg.registerAgent(viemAgent, POLICY);
        reg.record(ORDER, a, sig, TX);
        vm.stopPrank();
    }

    function test_revert_notOwner() public {
        EvidenceRegistry.Authorization memory a = _auth();
        bytes memory sig = _sign(agentPk, a);
        vm.expectRevert(EvidenceRegistry.NotOwner.selector);
        reg.record(ORDER, a, sig, TX);
        vm.expectRevert(EvidenceRegistry.NotOwner.selector);
        reg.registerAgent(agent, POLICY);
    }

    function test_revert_unregisteredAgent() public {
        EvidenceRegistry.Authorization memory a = _auth();
        a.from = vm.addr(0xB0B);
        bytes memory sig = _sign(0xB0B, a);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(EvidenceRegistry.AgentNotRegistered.selector, a.from));
        reg.record(ORDER, a, sig, TX);
    }

    function test_revert_duplicate() public {
        EvidenceRegistry.Authorization memory a = _auth();
        bytes memory sig = _sign(agentPk, a);
        vm.startPrank(owner);
        reg.record(ORDER, a, sig, TX);
        vm.expectRevert(abi.encodeWithSelector(EvidenceRegistry.AlreadyRecorded.selector, ORDER));
        reg.record(ORDER, a, sig, TX);
        vm.stopPrank();
    }

    /// 서명 후 기록 값을 바꾸면(수취인·금액·체인·토큰) 서명이 맞지 않는다
    function test_revert_tamperedFields() public {
        EvidenceRegistry.Authorization memory a = _auth();
        bytes memory sig = _sign(agentPk, a);
        vm.startPrank(owner);

        EvidenceRegistry.Authorization memory t = _auth();
        t.to = makeAddr("evil");
        vm.expectRevert(EvidenceRegistry.BadSignature.selector);
        reg.record(ORDER, t, sig, TX);

        t = _auth();
        t.value = 100_001;
        vm.expectRevert(EvidenceRegistry.BadSignature.selector);
        reg.record(ORDER, t, sig, TX);

        t = _auth();
        t.payChainId = 177;
        vm.expectRevert(EvidenceRegistry.BadSignature.selector);
        reg.record(ORDER, t, sig, TX);

        t = _auth();
        t.token = makeAddr("fakeToken");
        vm.expectRevert(EvidenceRegistry.BadSignature.selector);
        reg.record(ORDER, t, sig, TX);
        vm.stopPrank();
    }

    function test_revert_wrongSigner() public {
        EvidenceRegistry.Authorization memory a = _auth();
        bytes memory sig = _sign(0xB0B, a);
        vm.prank(owner);
        vm.expectRevert(EvidenceRegistry.BadSignature.selector);
        reg.record(ORDER, a, sig, TX);
    }

    function test_revert_malleableOrMalformedSig() public {
        EvidenceRegistry.Authorization memory a = _auth();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, reg.hashAuthorization(a));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory high = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.startPrank(owner);
        vm.expectRevert(EvidenceRegistry.BadSignature.selector);
        reg.record(ORDER, a, high, TX);
        vm.expectRevert(EvidenceRegistry.BadSignature.selector);
        reg.record(ORDER, a, hex"1234", TX);
        vm.stopPrank();
    }

    function test_revert_zeroValues() public {
        vm.expectRevert(EvidenceRegistry.ZeroValue.selector);
        new EvidenceRegistry(address(0));
        vm.startPrank(owner);
        vm.expectRevert(EvidenceRegistry.ZeroValue.selector);
        reg.registerAgent(agent, bytes32(0));
        EvidenceRegistry.Authorization memory a = _auth();
        bytes memory sig = _sign(agentPk, a);
        vm.expectRevert(EvidenceRegistry.ZeroValue.selector);
        reg.record(bytes32(0), a, sig, TX);
        vm.stopPrank();
    }

    function testFuzz_onlyAgentSignatureRecords(uint256 pk) public {
        pk = bound(pk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.assume(pk != agentPk);
        EvidenceRegistry.Authorization memory a = _auth();
        bytes memory sig = _sign(pk, a);
        vm.prank(owner);
        vm.expectRevert(EvidenceRegistry.BadSignature.selector);
        reg.record(ORDER, a, sig, TX);
    }
}
