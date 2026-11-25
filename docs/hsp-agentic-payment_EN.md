# HSP Agentic Payment — Setup and Execution Guide

**Environment:** HSP QA  
**Documentation revision:** 2026-10-30  
**Audience:** Hackathon project teams and MCP-capable AI agents

Connect your AI agent to HSP for on-chain payment acceptance and payment execution. The product name is **HSP Agentic Payment**. Use **`hsp-agentic-payment`** as the MCP configuration key.

This guide supports agent-orchestrated execution with the required human interactions. The project team must arrange IP allowlisting, complete wallet login, manually complete prerequisite wallet/token approvals, and fund the wallet with the correct test tokens. The agent must obtain the user confirmations specified below before signing and submitting a payment.

## 1. Provide Your IP Address to HSP for QA Allowlisting

**Complete this prerequisite before connecting to the MCP server.**

1. Identify the actual **public outbound (egress) IP address** used by the environment that will connect to HSP QA.
2. The hackathon project team must provide that IP address to HSP. **HSP Operations** will add it to the QA allowlist.
3. Wait for HSP to confirm that allowlisting is complete before connecting.

If the agent runs on a cloud server, through a VPN or proxy, or on another network, provide that environment's actual public egress IP. A private/local IP address is not sufficient. Contact HSP to update the allowlist if the egress IP changes.

**Agent action:** If allowlisting has not been confirmed, ask the user to complete this prerequisite and pause connection attempts. Do not repeatedly retry a blocked endpoint.

## 2. Prepare an AI Agent

This guide uses **Claude Code** as an example. Use an MCP-compatible client such as Claude Code, Cursor, Codex, or Grok, with access to the configured MCP tools and wallet skills.

A wallet is required for payment signing. The example below uses [OKX Agentic Wallet](https://web3.okx.com/zh-hans/onchainos/dev-docs/wallet/install-your-agentic-wallet).

## 3. Connect the MCP Server

**App Key and App Secret are centrally managed by the HSP server. Hackathon participants do not need to provide or configure them.**

Tell your agent:

```text
Connect HSP Agentic Payment to my current AI agent/MCP client.
Configuration key: hsp-agentic-payment
Transport: Streamable HTTP
URL: https://mcp-qa.hashkeymerchant.com/

Use the actual tool names and namespaces exposed by this client.
Client-added prefixes can differ; do not require a fixed user-hsp-agentic-payment namespace.

After connecting, list the available tools and confirm that all eight are present:
- get_chain_config
- create_order
- get_order
- prepare_payment
- finalize_payment
- estimate_fee
- submit_payment
- query_payment

Inspect the live input schemas and tool descriptions before calling tools.
Use actual returned values and the parameter types required by those schemas.
Do not invent arguments or treat example placeholders as real inputs.

If a required tool is missing, stop and report the missing tool.
In particular, do not proceed without finalize_payment.
Do not construct a JWT yourself or switch to another payment service.
```

The agent should configure the current client. Equivalent configuration examples follow. Preserve unrelated existing configuration.

### Claude Code

```bash
claude mcp add --transport http hsp-agentic-payment https://mcp-qa.hashkeymerchant.com/ --scope user
```

Equivalent JSON entry:

```json
{
  "mcpServers": {
    "hsp-agentic-payment": {
      "type": "http",
      "url": "https://mcp-qa.hashkeymerchant.com/"
    }
  }
}
```

### Cursor

Configuration file: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "hsp-agentic-payment": {
      "url": "https://mcp-qa.hashkeymerchant.com/"
    }
  }
}
```

### Codex

Configuration file: `~/.codex/config.toml`

```bash
codex mcp add hsp-agentic-payment --url https://mcp-qa.hashkeymerchant.com/
```

```toml
[mcp_servers.hsp-agentic-payment]
url = "https://mcp-qa.hashkeymerchant.com/"
enabled = true
```

### Grok

Configuration file: `~/.grok/config.toml`

```bash
grok mcp add --transport http --scope user hsp-agentic-payment https://mcp-qa.hashkeymerchant.com/
```

```toml
[mcp_servers.hsp-agentic-payment]
url = "https://mcp-qa.hashkeymerchant.com/"
enabled = true
```

Keep one registration for this endpoint in the selected client. After changing configuration, start a new conversation and check the available tools again.

## 4. Prepare the Payer Wallet

This example uses [OKX Agentic Wallet](https://web3.okx.com/zh-hans/onchainos/dev-docs/wallet/install-your-agentic-wallet).

If Onchain OS is not installed, tell your agent:

```text
Run npx -y @okxweb3/onchainos-installer install to install the Onchain OS skills.

Install them in the skill directory appropriate for my current AI agent.
The installer requires Node.js 18 or later. Check node -v first.
If Node.js is missing, install a supported release that meets this requirement.
Verify the Node.js installation with node -v and confirm that the wallet skills are available.
```

Choose one login method and tell the agent:

```text
Sign in to Agentic Wallet with Google.
```

or

```text
Sign in to Agentic Wallet with email.
```

or

```text
Sign in to Agentic Wallet with Apple.
```

The agent returns a login link. Open it in your browser and complete authentication. The first login creates a wallet:

```text
Wallet created successfully.
EVM address:    <EVM_ADDRESS>
Solana address: <SOLANA_ADDRESS>
```

Record the **EVM address**. Use it as the payer address only after separately confirming it with the user. Signing in again with the same email restores the existing wallet.

## 5. Manually Complete Wallet Approvals and Prepare Test Assets

**The hackathon project team must manually complete prerequisite wallet/token approvals, including any Permit2 token approval required by the selected protocol, and ensure that the payer wallet holds enough of the correct test token.** The agent must not perform these preparation transactions or obtain/fund test tokens on the team's behalf. The payment authorization signature in Step 7 remains part of the documented payment flow.

Call `get_chain_config` to identify the supported payment configuration. Use its current returned values for the cart's `network`, `chain_id`, `contract_address`, and `coin`, and for `prepare_payment.protocol`.

| Configuration | Authoritative source |
| --- | --- |
| Token contract address | `tokens[].address` for the selected token |
| Token decimals | `tokens[].decimals` for the selected token |
| Payment protocol | `tokens[].payment_protocol`: `eip3009` or `permit2` |
| Network and chain ID | The selected network's values returned by `get_chain_config` |

If multiple supported network/token combinations are available and the user's choice is not yet known, ask which one to use. Do not choose a contract, network, or protocol from memory.

Have the project team manually complete the required approvals and token funding for that configuration, then confirm that preparation is complete.

- The payer wallet must hold the token at **that exact contract address**. Another token with the same USDC symbol does not substitute for it.
- After `prepare_payment` returns `token_total_raw`, check the balance before signing, using the verified token decimals to compare amounts in consistent units. If the balance is below `token_total_raw`, do not sign; ask the project team to fund the wallet manually.
- Determine payment gas treatment from the order's `gas_fee_advanced` field. Do not infer it from the wallet balance alone.

| `gas_fee_advanced` | Payment fee treatment |
| --- | --- |
| `true` | The platform advances the network fee; it is not included in the payer's total payment amount. |
| `false` | The payer bears the network fee; it is included in the token authorization amount. `payment_details_total` equals `token_usd` plus `gas_fee`. |

The **Gateway broadcasts the payment transaction**. In this payment flow, the payer signs an authorization rather than a self-broadcast transaction that pays native gas directly. Prerequisite wallet/token approval transactions remain the project team's manual responsibility.

## 6. Create an Order

The server does not open an input form. The caller supplies the confirmed information. Clients that support individual prompts may use them; other clients should ask in the conversation.

**Ask one item at a time and wait for the answer before asking the next:**

1. Confirm `merchant_name`.
2. Confirm the recipient address, `pay_to`.
3. Separately confirm the payer address from the logged-in wallet. **Do not default the payer address to `pay_to`.**

Pass the confirmed values unchanged wherever required by the tool schemas.

**`merchant_name` is the hackathon team's reporting name.** An incorrect name affects post-event transaction aggregation. Use the same exact name throughout order creation and querying. It is a team attribution label, not an independent HSP merchant account identifier. The recipient is the user-confirmed EVM address supplied as `pay_to`.

Required `create_order` parameters:

| Parameter | Meaning |
| --- | --- |
| `merchant_name` | The team name confirmed by the user. |
| `pay_to` | The recipient EVM address confirmed by the user: a 42-character address beginning with `0x`. |
| `cart_mandate` | The cart mandate. `amount.currency` must be `USD`. Do not provide `merchant_authorization`. |

The cart mandate must include at least:

- `contents.id`
- `contents.cart_expiry`, formatted as RFC3339
- `contents.payment_request.method_data[]`
- `contents.payment_request.details`

Each `method_data` item describes one payment method:

- `supported_methods` must be `https://www.x402.org/`.
- `data.x402Version` must be `2`.
- Network and token values must come from the configuration obtained in Step 5.

Use the live `create_order` input schema for the complete cart structure and parameter types. The server uses the separately supplied `pay_to` to override each item's `data.pay_to`.

`create_order` returns `flow_id`, `payment_request_id`, and `payment_url`. Use `flow_id` to call `get_order`. Retain **both `flow_id` and `payment_request_id`** so subsequent calls and recovery refer to the same payment.

## 7. Sign and Submit the Payment

Tell your agent:

```text
Use HSP Agentic Payment to pay 1 USD.

Use the network, token contract, and protocol from the current get_chain_config response.
Confirm merchant_name and the recipient address with me one at a time before calling create_order.
Use the logged-in wallet's EVM address as the payer address, and confirm it with me separately.

Follow the prepare_payment -> wallet signing -> finalize_payment -> submit_payment flow.
Show me the recipient, payer, and token_total_raw and wait for explicit approval before signing.
Show them again and wait for explicit approval before submission.
```

### Execution sequence

1. **Call `prepare_payment`.** Supply `flow_id`, the confirmed payer address, and a protocol matching the selected token's `payment_protocol`: `eip3009` or `permit2`. Use the actual parameter names in the tool schema. The server reads the order and chain configuration and locks the quote. Do not construct x402 JSON yourself or write a payment-construction script.
2. **Confirm and sign.** Show `pay_to`, the payer address, and `token_total_raw`; wait for the user's explicit approval. Sign only the returned `eip712` data. Preserve its `domain`, `types`, `primaryType`, and `message`. The `primaryType` is `TransferWithAuthorization` for `eip3009`, or `PermitTransferFrom` for `permit2`.
3. **Call `finalize_payment`.** Supply the wallet signature and the three values returned by `prepare_payment`: `payment_payload`, `payment_mandate_contents`, and `cart_hash`. The server inserts the signature, calculates `payment_hash`, generates the JWT, and returns `payment_mandate_json`.
4. **Confirm and submit.** Show the recipient address, payer address, and `token_total_raw` again. After the user approves, pass `payment_mandate_json` unchanged to `submit_payment`, using that tool's input schema.

### Example response and parameter mapping

**The following JSON blocks are illustrative examples, not executable payloads.** Angle-bracket values describe placeholders; empty example objects stand for the full data returned by the server. Never sign or submit the example values.

`prepare_payment` returns the following fields. The amount is already embedded in `eip712`:

```json
{
  "eip712": { "domain": {}, "types": {}, "primaryType": "TransferWithAuthorization", "message": {} },
  "cart_hash": "<64_CHARACTER_HEX_VALUE>",
  "token_total_raw": "<LOCKED_RAW_TOKEN_AMOUNT>",
  "quote_expires_at": "<RFC3339_TIMESTAMP>",
  "pay_to": "<RECIPIENT_ADDRESS>",
  "payer": "<PAYER_ADDRESS>",
  "payment_request_id": "<PAYMENT_REQUEST_ID_FROM_CREATE_ORDER>",
  "payment_payload": { "payload": { "signature": "" } },
  "payment_mandate_contents": {}
}
```

The wallet signs `eip712` using **EIP-712**, producing a **65-byte signature beginning with `0x`**. Then call `finalize_payment` with the corresponding values:

```json
{
  "signature": "<WALLET_SIGNATURE>",
  "payment_payload": "<prepare_payment.payment_payload, unchanged>",
  "payment_mandate_contents": "<prepare_payment.payment_mandate_contents, unchanged>",
  "cart_hash": "<prepare_payment.cart_hash>"
}
```

The quoted placeholders above identify data sources; they are not instructions to convert returned objects into strings. Pass the **actual returned values in the types required by the live `finalize_payment` schema**, preserving their contents. Do not add the signature to the payload yourself.

The returned `payment_mandate_json` is the **only input parameter** to `submit_payment`. Do not manually insert signatures, calculate hashes, or assemble a JWT.

### Quote and retry rules

- A quote is valid for **5 minutes**, with the exact deadline given by **`quote_expires_at`**.
- Use the returned **`token_total_raw` exactly**. It is the raw token authorization amount; do not recalculate or round it for signing.
- If the quote expires, or the Gateway returns **`30043`**, call `prepare_payment` again and obtain a new signature over the new `eip712`, with the new `token_total_raw`. Do not submit the old signature.
- A successful submission has status **`payment-submitted`**. This is not final confirmation.
- If the submission response is delayed or uncertain, query the existing payment before taking further action. Do not create a duplicate order or blindly resubmit.

## 8. Query the Payment and Recover Its Status

Call `query_payment` with the order's `flow_id` or `payment_request_id`, and the same team name in **`expected_merchant_name`**. **`attribution_verified` must be `true`** before reporting that the payment is attributed to that team.

Query **every 15 seconds**, retaining the same pair of identifiers:

| Returned status | Agent action |
| --- | --- |
| `payment-submitted`, `payment-verified`, `payment-processing`, `payment-included` | Continue querying the same payment. |
| `payment-timeout` | The payment remains recoverable. Continue querying the same payment; do not create a new order. |
| `payment-safe` | Stop polling. Report: "The transaction is on-chain and has received half of the required block confirmations. It is not yet finalized." |
| `payment-finalized` | Stop polling. Report: "The payment has reached final confirmation." This is the irreversible state in the documented HSP flow. |
| `payment-failed` | Stop polling and report `payment.status_reason`. |

**HSP status definition:** `payment-safe` means that the transaction is on-chain and has received half of the required block confirmations. It must not be presented as `payment-finalized`. `payment-included` is still a polling state in this workflow.

The on-chain transaction hash is in **`payment.tx_signature`**. It is empty before broadcast.

If 10 minutes pass without reaching `payment-safe`, `payment-finalized`, or `payment-failed`, report **"Pending confirmation"**, print `flow_id` and `payment_request_id`, and continue querying the same payment. If the client/session cannot continue polling, retain those identifiers for resuming `query_payment`; do not create a replacement order.

If a query fails or an unrecognized status is returned, show the actual error/status. Do not infer payment success or fabricate a failure state. Retain the identifiers for recovery.

### Result report

Use actual returned or retained values in this output template:

```text
HSP Agentic Payment — QA Result
Payment status: <ACTUAL_STATUS_FROM_QUERY_PAYMENT>
Hackathon team: <merchant_name>
Team attribution verified: <attribution_verified>
Network: <payment.network>
Raw authorization amount (raw units): <token_total_raw>
Recipient address: <payment.to_pay_address>
Payer address: <payment.payer_address>
Transaction hash: <payment.tx_signature>
```

Keep `token_total_raw` labeled as **raw units**. An optional human-readable token amount may be displayed using the verified token decimals, without changing the raw amount used for signing. Do not label an authorization amount as actual funds received.

If a value is not returned, say that it is unavailable. Report the actual status and attribution result separately. Never fabricate successful execution, a signature, a transaction hash, team attribution, or final confirmation.

## Endpoint and Operational Notes

- **MCP endpoint:** `https://mcp-qa.hashkeymerchant.com/`
- **Transport:** Streamable HTTP.
- **Health check:** `GET https://mcp-qa.hashkeymerchant.com/health`; expected response: `{"status":"ok"}`. This confirms that the process is alive; it does not by itself confirm tool availability or payment execution.
- **Tool availability:** Use the current conversation's actual MCP tool list as the authority. All required tools, including `finalize_payment`, must be available before the signing/submission flow begins.
- **Team aggregation:** `merchant_name` is the hackathon team's reporting name. Enter it accurately at order creation and use the same exact name when querying.
- **Credentials:** HSP manages App Key/App Secret on the server. Participants do not need to configure them.
