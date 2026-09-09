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

Package name: `@benheidenreich/n8n-nodes-autocrm`

### From npm

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation: **Settings → Community Nodes → Install**, enter the package name, confirm the risk acknowledgement.

On a self-hosted instance this works as soon as the package is on npm — n8n's verification is a quality badge (relevant for n8n Cloud), not a prerequisite for installing. Community packages are enabled by default; to set it explicitly:

```yaml
environment:
  - N8N_COMMUNITY_PACKAGES_ENABLED=true
```

### From a local package file (Docker)

Useful for testing a build before publishing. Community nodes live in the n8n data directory under `~/.n8n/nodes`.

Build the tarball in the repository:

```bash
npm install
npm run build
npm pack     # → benheidenreich-n8n-nodes-autocrm-<version>.tgz
```

Copy it to the server, then install it **as the `node` user** — installing as root causes permission problems later:

```bash
docker cp benheidenreich-n8n-nodes-autocrm-0.1.1.tgz n8n:/tmp/
docker exec -it -u node n8n sh -c "mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && npm install /tmp/benheidenreich-n8n-nodes-autocrm-0.1.1.tgz"
docker restart n8n
```

With docker compose, use `docker compose cp` / `docker compose exec -u node` / `docker compose restart` accordingly.

If `/home/node/.n8n` is a mounted volume (the usual setup), the installation survives container restarts and image updates. To update, raise the version, rebuild and repeat the install — npm replaces the previous version. To remove it:

```bash
docker exec -it -u node n8n sh -c "cd /home/node/.n8n/nodes && npm uninstall @benheidenreich/n8n-nodes-autocrm"
docker restart n8n
```

### Verifying the installation without creating data

1. Open n8n, create a workflow and search the node panel for **autocrm** — the node must appear.
2. Create the credentials and press **Test** (see [Credentials](#credentials)). This performs a read-only API call.
3. Run the **Exists** operation with any lead ID. It is read-only and creates nothing.

Only after that consider importing the example workflow — its Create branch creates a **real lead**.

### Troubleshooting the installation

| Problem | Solution |
|---|---|
| Node does not appear in the panel | Did the container actually restart? `docker logs n8n 2>&1 \| grep -i autocrm` shows loading errors |
| `EACCES` / permission errors on npm install | Run `docker exec` **with `-u node`**. If root-owned files already exist: `docker exec -u root n8n chown -R node:node /home/node/.n8n/nodes` |
| "Community nodes disabled" | Set `N8N_COMMUNITY_PACKAGES_ENABLED=true` in the environment and recreate the container (`docker compose up -d`) |
| Credential test fails with "Could not reach …" | The container needs **direct** outbound HTTPS access to `www.autocrm.de` and its sibling subdomains — the node uses native `fetch` and ignores n8n proxy variables. Check the firewall and DNS inside the container |

## Operations

All operations act on the **Lead** resource. Every request goes to the same endpoint; the operation selects the API function.

### Create (`NeueAnfrage`)

Creates the lead **and** its contact in a single call. Throughput limit: **3 per 60 seconds** — the bottleneck for bulk imports.

Required: Contact ID, Last Name, at least one of Email / Phone / Mobile, Branch ID, Category, First Contact Channel, Source, Note Title, Note Content.

**Vehicle** may only be filled when the category is configured as a vehicle lead in autocrm; for LMS categories the object must be omitted. If autocrm already knows the vehicle ID, the existing vehicle is linked and Description is ignored. Both vehicle fields are required together.

Valid values for **Branch ID**, **Source** and the **category paths** are tenant-specific — ask autocrm support.

Output:

| Field | Meaning |
|---|---|
| `id-anfrage` | The lead ID — the key for every follow-up operation. **Persist it.** |
| `id-kontakt` | autocrm-internal contact ID (required by e.g. `KontaktKomplettieren`) |
| `neuer-kontakt` | `true` = a new contact was created, `false` = attached to an existing one. May be absent from the response — evaluate defensively |
| `praefix-suchekontakte` | Whether the Contact ID falls into a prefix range. May also be absent |

### Assign (`AnfrageZuweisen`)

Assigns a lead to a branch, category and employee or team. Despite what the API name may suggest, it does not link emails to leads.

- **Assign To: Employee** — Employee Email must match exactly **one** employee who is a valid assignee for the lead's branch and category, otherwise the API returns `fehler_input:unbekannt:data.email`. See [The two email address traps](#the-two-email-address-traps).
- **Assign To: Team** — assigns to the responsible team for the branch and category. This is a real assignment, not "leave unchanged".
- **Branch ID / Category empty** — branch and category stay unchanged. The category must exist in the target branch.
- The lead may end up with a **substitute** employee.

### Attach Email (`AnfrageEmail`)

Archives an already sent or received email (.eml) in the lead history. **This does not send anything** — send the email first, e.g. with n8n's built-in Send Email node, then attach it here.

Two input modes:

- **Binary File** (default) — an `.eml` file from a binary field, e.g. from the IMAP trigger ("Download Attachments" / RAW format) or an earlier workflow step.
- **Raw EML Text** — the complete RFC 822 message (headers, blank line, body) as a string; the node base64-encodes it. Useful after the Send Email node, which does not produce a finished `.eml`: rebuild the message from the same fields via expressions.

The specification requires at least the `MIME-Version`, `Content-Type`, `From`, `To`, `Date` and `Subject` headers. autocrm cannot read S/MIME-encrypted mail. Maximum 50 MB (base64 size); the node checks this before sending.

### Add Note (`AnfrageNotiz`)

Adds a note, optionally with file attachments, to the lead history.

- **Keep Status Unchanged** — by default a new note also changes the lead status; this switch keeps it.
- **Attachments** — one binary field per entry. The file name comes from the binary metadata and can be overridden (path components are stripped). **Image Optimization** (on by default) lets autocrm recompress images.
- Size limit: 50 MB base64 **per attachment and in total** — the node checks both before sending. The MIME type is determined server-side.

### Exists (`AnfrageVorhanden`)

Checks whether a lead exists and, if it was merged away, which lead its content lives in now. Read-only, 150 calls per 60 seconds — a good connectivity test.

- `existiert` — `1`/`0`, within the API user's permissions.
- `weitergefuehrt-in` — if the lead was deleted by a **merge**, this holds the ID of the successor lead, which is how you find relocated leads again. Otherwise `null`.

## Credentials

You need an API user for the autocrm API3. Credentials (username and password for HTTP Basic Auth) are issued by autocrm support; the valid values for branch IDs, sources and categories are tenant-specific and also come from support.

1. In n8n, create new **autocrm API** credentials.
2. Keep the default **Base URL** (`https://www.autocrm.de/api/api3`) unless support tells you otherwise.
3. Enter the **Username** and **Password** of the API user.

The credential test performs a real, read-only API call (`AnfrageVorhanden` for lead ID 1). Any JSON answer from the API proves the credentials are valid — so the message `Credentials are valid (server responded with "fehler_berechtigung")` is a **success** as well; it only means the API user is not allowed to call that particular function.

**Important:** autocrm allows only **one request at a time per API user**. Use a dedicated API user for your n8n instance and do not share it with other integrations running in parallel.

## Compatibility

- Requires n8n running on Node.js 18.10 or newer (the node uses native `fetch`). Any n8n image from roughly version 1.0 onwards satisfies this.
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

### API field names of the ID parameters

The node's parameter descriptions stay free of the raw API field names; this is where they are documented:

| Node parameter | autocrm API field |
|---|---|
| Lead ID | `id-anfrage` |
| Contact ID | `x-id-kontakt` |
| External Lead ID | `x-id-anfrage` |
| Vehicle → Vehicle ID | `x-id-fahrzeug` |

### Contact upsert semantics (Create)

`Contact ID` (`x-id-kontakt`) is the ID of the contact in **your** system and acts as an upsert key. If autocrm already knows the ID, the lead is attached to the existing contact and all other contact fields are silently ignored (except License Plate). This happens with HTTP 200 — it is not an error.

Check `neuer-kontakt` in the output: `false` for an ID you just generated means the ID collided with an existing contact, and the lead is now attached to a **different person**.

An assigned `x-id-kontakt` **cannot be changed**, and there is no API function to search for contacts — duplicate detection is entirely on your side. Clarify the rules for assigning contact IDs (permitted prefix ranges and the behaviour on violation) with autocrm support before going live.

### Rate limits and serialization

autocrm enforces throughput limits per function and allows only one request at a time per API user:

| Operation | Limit |
|---|---|
| Create | 3 / 60 s |
| Assign, Attach Email, Add Note | 5 / 60 s each |
| Exists | 150 / 60 s |

The node serializes its requests per credential within one n8n process and automatically retries temporary errors (HTTP 429/503, `fehler_parallel`, `fehler_mengengeruest`, `fehler_tmp`) up to two times, honoring the `Retry-After` header (capped at 30 s per wait). For bulk imports, slow the workflow down (e.g. Loop Over Items with a Wait node) — the Create limit of 3 per 60 seconds is the bottleneck.

Note that the serialization is per process: with n8n in queue mode across several workers, or several n8n instances sharing one API user, the retries are what catch `fehler_parallel`. Use one API user per n8n installation.

### Error statuses

A call counts as successful only when it returns HTTP 2xx **and** `status: "OK"` — the node checks both.

| Status error | Meaning |
|---|---|
| `fehler_parallel` | Another request of the same API user was already running — the node has already retried automatically |
| `fehler_mengengeruest` | Throughput limit exceeded → slow the workflow down |
| `fehler_tmp` | Temporary condition, e.g. a phone call is in progress on the lead → retry later |
| `fehler_input:<detail>:<field>` | Input error, e.g. `id_unbekannt:data.id-anfrage` (unknown lead ID) or `unbekannt:data.email` (no unique external employee address for that branch and category) |
| `fehler_berechtigung` | The API user is not allowed to call this function → contact autocrm support |
| `fehler_wartungsarbeiten` | Maintenance window → retry later |
| HTTP 401 | Wrong credentials. The server answers with HTML instead of JSON here; the node detects that and reports it properly. |

### Transport notes

- The autocrm API normally answers with an HTTP 308 redirect to another subdomain. The node follows redirects manually so that method, body and the `Authorization` header survive, and remembers the redirect target for subsequent requests.
- The node performs its HTTP requests with native `fetch` and therefore does **not** use n8n's proxy settings (`HTTP_PROXY`). The n8n host needs direct outbound HTTPS access to `www.autocrm.de` and its sibling subdomains (e.g. `www2.autocrm.de`).
- Timestamps (Process From/By, Close By) are converted to German local time (Europe/Berlin) in the format autocrm expects. Phone numbers must be in international format (`+496301708123456`); common separators are stripped automatically.

### Use as an AI Agent tool

The node is marked as `usableAsTool` — it can be attached to an n8n **AI Agent** as a tool, with parameter values filled from the model via `$fromAI`.

### Example workflow

An importable example workflow is included in [`examples/example-workflow.json`](examples/example-workflow.json): Manual Trigger → Create → Assign, plus detached Attach Email and Exists nodes with sample values.

**Careful:** executing it against real credentials creates a real lead in your autocrm tenant. Replace the placeholders (`BRANCH_ID`, `CATEGORY`, `SOURCE_NAME`, the email addresses) with your tenant's values first — autocrm support will tell you the valid ones.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [autocrm by IMAGO Informationstechnologie GmbH](https://www.autocrm.de) — the API3 specification (PDF) is available from autocrm support

## Version history

- **0.1.1** — Compliance with n8n's community node verification scan: credential icon and title-cased credential display name, `NodeConnectionTypes.Main` instead of the `"main"` literal, all errors surfaced as `NodeApiError`/`NodeOperationError`, `sleep` from `n8n-workflow` instead of `setTimeout`. The API field names moved from the parameter descriptions into this README.
- **0.1.0** — Initial release: Lead Create, Assign, Attach Email, Add Note and Exists; manual 308 redirect handling with credential preservation; per-user request serialization; automatic retries with Retry-After; programmatic credential test.
