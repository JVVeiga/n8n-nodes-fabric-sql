# n8n-nodes-fabric-sql

An n8n community node that queries a **Microsoft Fabric SQL analytics endpoint** — a Lakehouse
or a Warehouse — using an **Entra ID service principal**.

n8n's built-in Microsoft SQL node cannot log in to `*.datawarehouse.fabric.microsoft.com`, and
offers no service principal authentication. This node does both, binds query parameters
properly, and reports connection failures with a cause instead of a timeout.

---

## Requirements

| Requirement | Detail |
| --- | --- |
| n8n | Self-hosted. Not installable on n8n Cloud — see [Why not n8n Cloud](#why-not-n8n-cloud). |
| Node.js | 20.15 or newer |
| Authentication | Microsoft Entra ID only. Fabric has no SQL login. |
| Network | Outbound **TCP 1433** from the n8n host to `*.datawarehouse.fabric.microsoft.com` |
| Tenant setting | **Service principals can use Fabric APIs** must be enabled (Fabric admin portal → Tenant settings → Developer settings) |
| Access | The service principal must be added to the Fabric **workspace**, or to the lakehouse/warehouse **item** |

**No ODBC driver install is required.** Microsoft's own examples use `ODBC Driver 18 for SQL
Server`, which is a requirement of the Python/pyodbc path. This node speaks TDS directly from
JavaScript through `mssql`/`tedious`, so there is nothing to install on the n8n host.

---

## Installation

**Via the n8n UI** (self-hosted): Settings → Community nodes → Install →
`n8n-nodes-fabric-sql`.

**Manually**, into your n8n custom nodes folder:

```bash
cd ~/.n8n/custom
npm install n8n-nodes-fabric-sql
```

Restart n8n afterwards.

---

## Credential setup

Create a **Microsoft Fabric SQL API** credential:

| Field | Where it comes from |
| --- | --- |
| **Server** | Lakehouse or Warehouse → Settings → **SQL connection string**. Host only. |
| **Database** | The lakehouse or warehouse name, e.g. `my_lakehouse` |
| **Tenant ID** | Entra ID → App registrations → your app → **Directory (tenant) ID** |
| **Client ID** | Same page → **Application (client) ID** |
| **Client Secret** | Certificates & secrets → the secret **value**, shown once at creation |
| **Allow Write Operations** | Leave off unless the target is a Warehouse — see [Read-only](#read-only-by-default) |
| **Connect / Request Timeout** | Milliseconds, default 30000 each |

Then click **Test**. On success you get `Connection successful`. On failure you get a message
naming the actual cause, not a timeout.

### Two things people get wrong

**Client ID is the client ID alone.** Microsoft's ODBC examples use a composite
`UID=client_id@tenant_id`. That is an ODBC-specific format. This driver takes the two ids as
separate fields, so pasting `client_id@tenant_id` into Client ID produces a login failure.

**Server is a host name, not a connection string.** `abc123.datawarehouse.fabric.microsoft.com`
is right. A `tcp:` prefix or a `,1433` suffix is cleaned up automatically; a full
`DRIVER={...};SERVER=...` string is rejected with an explanation.

---

## Operations

### Query → Execute Query

Run SQL and get one item per row.

```sql
SELECT TOP 10 * FROM my_lakehouse.dbo.orders WHERE created_at > ?
```

Add each value under **Query Parameters**, in the order the `?` marks appear. Values are sent
as bound TDS parameters and never spliced into the SQL text, so a value containing a quote is
data and not syntax.

A plain parameter entry is sent as text. To send a number, boolean or null, use an expression:
`{{ 42 }}`, `{{ true }}`, `{{ null }}`.

A `?` inside a string literal, a comment, or a quoted identifier is left alone — it is not
counted as a placeholder.

### Row → Select

Pick a table, optionally name columns, set a limit, and add filter conditions. Column and table
names are quoted; filter values are bound.

### Row → Insert / Update / Delete

Warehouse only, and hidden behind **Allow Write Operations** on the credential.

- **Insert** writes the incoming items as rows, batched so no statement exceeds SQL Server's
  2100-parameter limit.
- **Update** matches rows by one column, reading both the match value and the new values from
  each item.
- **Delete** matches rows by one column, collecting the values from all incoming items into
  chunked `IN (...)` lists. An item with no value for the match column is skipped rather than
  matched as `NULL`.

### Schema → List Tables / Describe Table

`List Tables` returns every table and view visible to the principal, including a
`qualifiedName` (`schema.table`) you can feed straight into the other operations.
`Describe Table` returns column names, types, lengths and nullability. A table name that
matches nothing returns no items rather than an error.

---

## Read-only by default

A **Lakehouse SQL analytics endpoint is read-only.** `SELECT` works; `INSERT`, `UPDATE` and
`DELETE` are rejected by Fabric.

A Fabric **Warehouse** does accept writes, and is reached through the same host name — which is
why the write operations exist at all, and why they are gated on a credential toggle rather
than presented as ordinary capabilities.

With the toggle off, the node checks submitted SQL locally and refuses a write before
contacting the server, so you get an explanation instead of a driver rejection. This check is a
usability guard, not a security boundary: Fabric enforces read-only access itself, and the
check is skipped entirely when the toggle is on.

---

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `Client secret was rejected by Entra ID (AADSTS7000215)` | Wrong secret, or the secret **ID** was pasted instead of the secret **value**. Create a new secret and copy the value. |
| `The client secret has expired (AADSTS7000222)` | Create a new secret on the app registration. |
| `Application ... was not found in tenant ... (AADSTS700016)` | Wrong Client ID or Tenant ID. Check that Client ID has no `@tenant` suffix. |
| `Tenant ... was not found (AADSTS90002)` | Wrong Tenant ID. |
| `Could not reach ...:1433` | Outbound TCP 1433 is blocked, or the host is wrong. Re-copy it from the SQL connection string. |
| `The service principal authenticated but has no access to ...` | Add the principal to the Fabric workspace or to the item, and enable **Service principals can use Fabric APIs** in tenant settings. |
| `This endpoint is read-only (INSERT is not allowed)` | Expected against a Lakehouse endpoint. Writes need a Warehouse plus **Allow Write Operations**. |
| `Query has 2 '?' placeholders but 1 value was provided` | Add the missing Query Parameter entry. |
| `Enter only the host name ...` | The Server field has a connection string or URL in it. Use the bare host. |
| Silent timeout with no message | Almost always Client ID in the composite `client_id@tenant_id` form, or TCP 1433 closed. |

### First connection with a brand-new service principal

A newly created principal is reported to need one Fabric REST API call before the SQL endpoint
will accept it. The credential test makes that call for you (`GET /v1/workspaces`) before
opening the connection.

This step is not documented publicly by Microsoft, so it is treated as best effort: if the REST
call fails, the credential test does not fail because of it. Its failure is only reported as
extra context when the connection also fails.

---

## Notes on implementation

**No `tedious` fork is needed.** The Fabric handshake incompatibility was fixed upstream —
[#1668](https://github.com/tediousjs/tedious/issues/1668) in tedious v19.1.0 ("support Azure SQL
Database in Microsoft Fabric") and [#1718](https://github.com/tediousjs/tedious/issues/1718) in
v19.2.1 ("rework FeatureExt generation"). This package depends on `mssql@^12`, which resolves
`tedious >= 19.2.2`, so a stock driver connects.

**TLS is not negotiable.** Connections use `encrypt: true` with
`trustServerCertificate: false`, and that is not exposed as an option. The endpoint is
Microsoft-hosted with a valid certificate, so disabling validation could only ever hide a
man-in-the-middle.

**Duplicate column names survive.** Queries run in the driver's `arrayRowMode`, so
`SELECT a.id, b.id` returns `id` and `id_1` rather than silently dropping one of them.
`varbinary` becomes base64, dates become ISO strings, and `bigint` becomes a decimal string so
large values do not lose precision.

### Why not n8n Cloud

n8n Cloud does not allow community nodes with runtime dependencies, and there is no way to speak
the TDS wire protocol without a driver. This is the same reason n8n ships its Microsoft SQL node
built in rather than as a community package. Self-hosted only.

---

## Development

```bash
npm install        # skips install scripts, see .npmrc
npm run typecheck  # sources and tests
npm run lint       # n8n community node lint rules
npm test           # unit and contract suite — no credentials, no network
npm run build      # compile to dist/
npm run dev        # run against a local n8n
```

The test suite needs no Fabric tenant. The pure logic — placeholder scanning, identifier
quoting, the read-only guard, result coercion, query building — is tested as plain functions,
and the operations are tested against a pool that records the SQL and the bound parameters,
which is how "the value was bound, not interpolated" is actually verified.

Copy `.env.example` to `.env` only if you want to check against a real endpoint by hand.

## License

MIT
