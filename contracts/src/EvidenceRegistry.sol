// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title EvidenceRegistry — Countersign 결제 증거 기록 (HSK Chain 메인넷)
/// @notice 에이전트 지갑이 HSP 결제에 서명한 EIP-3009 TransferWithAuthorization을 증거로 남긴다.
///         결제는 HSP가 연 체인 어디서든 일어나고, 증거는 HSK Chain에 모인다.
/// @dev    서명 검증을 체인 위에서 다시 한다: 기록된 payTo·amount·token·payChainId는 등록된 에이전트가
///         실제로 서명한 typed data에서 나온 값이다. orderHash와 payTxHash는 주인(owner)만 붙일 수 있다.
///         폐기(revoke)·누적 한도·위임 로직은 넣지 않는다 (팀 출품작 영역, PROJECT.md §2.4).
contract EvidenceRegistry {
    /// @dev EIP-3009 TransferWithAuthorization 한 건 + 그 서명 대상 도메인
    struct Authorization {
        address token; // domain.verifyingContract
        uint256 payChainId; // domain.chainId
        string name; // domain.name
        string version; // domain.version
        address from; // 에이전트 계정
        address to; // 판매자
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    /// @dev secp256k1n / 2 (낮은 s만 허용, 서명 변형 방지)
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public immutable owner;
    /// @notice 에이전트 계정 → 정책 해시 (0이면 미등록)
    mapping(address agent => bytes32 policyHash) public policyHashOf;
    /// @notice 같은 주문을 두 번 기록하지 않는다
    mapping(bytes32 orderHash => bool) public recorded;

    event AgentRegistered(address indexed agent, bytes32 policyHash);
    event EvidenceRecorded(
        address indexed agent,
        bytes32 indexed orderHash,
        address indexed payTo,
        bytes32 typedDataHash,
        address token,
        uint256 amount,
        uint256 payChainId,
        bytes32 payTxHash
    );

    error NotOwner();
    error ZeroValue();
    error AgentNotRegistered(address agent);
    error AlreadyRecorded(bytes32 orderHash);
    error BadSignature();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroValue();
        owner = owner_;
    }

    /// @notice 주인이 에이전트 계정과 정책 해시를 등록한다 (정책을 바꾸면 다시 등록)
    function registerAgent(address agent, bytes32 policyHash) external onlyOwner {
        if (agent == address(0) || policyHash == bytes32(0)) revert ZeroValue();
        policyHashOf[agent] = policyHash;
        emit AgentRegistered(agent, policyHash);
    }

    /// @notice 결제 증거 기록. 서명자가 등록된 에이전트(a.from)인지 체인 위에서 확인한다.
    /// @return typedDataHash 에이전트가 서명한 EIP-712 digest
    function record(bytes32 orderHash, Authorization calldata a, bytes calldata signature, bytes32 payTxHash)
        external
        onlyOwner
        returns (bytes32 typedDataHash)
    {
        if (orderHash == bytes32(0) || payTxHash == bytes32(0)) revert ZeroValue();
        if (policyHashOf[a.from] == bytes32(0)) revert AgentNotRegistered(a.from);
        if (recorded[orderHash]) revert AlreadyRecorded(orderHash);

        typedDataHash = hashAuthorization(a);
        if (_recover(typedDataHash, signature) != a.from) revert BadSignature();

        recorded[orderHash] = true;
        emit EvidenceRecorded(a.from, orderHash, a.to, typedDataHash, a.token, a.value, a.payChainId, payTxHash);
    }

    /// @notice EIP-712 digest (오프체인 wallet-core/evidence.ts typedDataHash와 같은 값)
    function hashAuthorization(Authorization calldata a) public pure returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(a.name)), keccak256(bytes(a.version)), a.payChainId, a.token)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
