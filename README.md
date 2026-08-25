# @benheidenreich/n8n-nodes-autocrm

This is an n8n community node. It lets you use [autocrm](https://www.autocrm.de) in your n8n workflows.

autocrm is a lead management CRM for automotive dealerships by IMAGO Informationstechnologie GmbH. This node talks to the autocrm API3 (version 3.5) to create leads, assign them to branches, categories and employees, and to document emails and notes in the lead history.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

Package name: `@benheidenreich/n8n-nodes-autocrm`

## Operations

**Lead**

- Create — create a new lead together with its contact (`NeueAnfrage`)
- Assign — assign a lead to a branch, category and employee or team (`AnfrageZuweisen`)
- Attach Email — archive an already sent or received email (.eml) in the lead history (`AnfrageEmail`). **This does not send anything** — send the email first, e.g. with n8n's built-in Send Email node, then attach it here.
- Add Note — add a note, optionally with file attachments, to the lead history (`AnfrageNotiz`)
- Exists — check whether a lead exists and, if it was merged away, which lead its content lives in now (`AnfrageVorhanden`)

## Credentials

You need an API user for the autocrm API3. Credentials (username and password for HTTP Basic Auth) are issued by autocrm support; the valid values for branch IDs, sources and categories are tenant-specific and also come from support.

1. In n8n, create new **autocrm API** credentials.
2. Keep the default **Base URL** (`https://www.autocrm.de/api/api3`) unless support tells you otherwise.
3. Enter the **Username** and **Password** of the API user.

The credential test performs a real, read-only API call (`AnfrageVorhanden` for lead ID 1). Any JSON answer from the API proves the credentials are valid — even when it reports a permission error for that particular function.

**Important:** autocrm allows only **one request at a time per API user**. Use a dedicated API user for your n8n instance and do not share it with other integrations running in parallel.

## Compatibility

- Requires n8n running on Node.js 18.10 or newer (the node uses native `fetch`).
- Implements autocrm API3, interface version 3.5.
- No runtime dependencies.

## Usage

A typical outbound pipeline:

1. **Create** the lead from your web form or portal data — the output contains `id-anfrage` (the lead ID for all further operations) and `id-kontakt`.
2. Send the confirmation email to the customer with n8n's **Send Email** node (autocrm has no API function for sending).
3. **Attach Email** to document that email in the lead history (from a binary `.eml` field, or as raw RFC 822 text that the node base64-encodes).
4. **Assign** the lead to the responsible employee or team.

### The two email address traps

| Field | Expected address |
|---|---|
| Create → Assignee Email (`bearbeiter`) | The employee's **autocrm login** address |
| Assign → Employee Email (`email`) | The employee's **external dealership** address |

Assigning without an employee email (Assign To: Team) assigns the lead to the responsible **team** of the branch and category — it does not mean "unchanged".

### Contact upsert semantics (Create)

`Contact ID` (`x-id-kontakt`) is the ID of the contact in **your** system and acts as an upsert key. If autocrm already knows the ID, the lead is attached to the existing contact and all other contact fields are silently ignored (except License Plate). Check `neuer-kontakt` in the output: `false` for an ID you just generated means the ID collided with an existing contact.

### Rate limits and serialization

autocrm enforces per-function throughput limits (Create 3/60s; Assign, Attach Email and Add Note 5/60s; Exists 150/60s) and allows only one request at a time per API user. The node serializes its requests per credential within one n8n process and automatically retries temporary errors (HTTP 429/503, `fehler_parallel`, `fehler_mengengeruest`, `fehler_tmp`) up to two times, honoring the `Retry-After` header (capped at 30 s per wait). For bulk imports, slow the workflow down (e.g. Loop Over Items with a Wait node) — the Create limit of 3 per 60 seconds is the bottleneck.

### Transport notes

- The autocrm API normally answers with an HTTP 308 redirect to another subdomain. The node follows redirects manually so that method, body and the `Authorization` header survive, and remembers the redirect target for subsequent requests.
- The node performs its HTTP requests with native `fetch` and therefore does **not** use n8n's proxy settings (`HTTP_PROXY`). The n8n host needs direct outbound HTTPS access to `www.autocrm.de` and its sibling subdomains (e.g. `www2.autocrm.de`).
- Timestamps (Process From/By, Close By) are converted to German local time (Europe/Berlin) in the format autocrm expects. Phone numbers must be in international format (`+496301708123456`); common separators are stripped automatically.

### Use as an AI Agent tool

The node is marked as `usableAsTool` — it can be attached to an n8n **AI Agent** as a tool, with parameter values filled from the model via `$fromAI`.

An importable example workflow is included in [`examples/beispiel-workflow.json`](examples/beispiel-workflow.json). **Careful:** executing it against real credentials creates a real lead in your autocrm tenant.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [autocrm by IMAGO Informationstechnologie GmbH](https://www.autocrm.de) — the API3 specification (PDF) is available from autocrm support

## Version history

- **0.1.0** — Initial release: Lead Create, Assign, Attach Email, Add Note and Exists; manual 308 redirect handling with credential preservation; per-user request serialization; automatic retries with Retry-After; programmatic credential test.
