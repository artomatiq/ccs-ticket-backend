# CCS Ticket App

A ticket processing app for a small trucking/construction business. Drivers photograph paper tickets in the field; the app validates, extracts, and populates a Google Sheet, then generates invoices as PDFs.

---

## Pipeline Overview

```mermaid
flowchart TD
    A([Driver]) -->|passcode| B[POST /login]
    B --> C[TicketDriverLogin Lambda\nreturns JWT]

    C --> D[OpenCV preprocessing\nin browser]
    D --> E[POST /upload-ticket]
    E --> F[TicketPresignHandler\nDB: awaiting-upload]
    F -->|presigned URL| G[Client PUT → S3 /raw]

    G --> H[TicketDbWriter\nDB: uploaded]
    H --> I{{EventBridge}}
    I --> J[TicketValidator\nDB: validating]
    J -->|pass| K[S3 /validated\nDB: validated]
    J -->|fail| L[S3 /rejected\nDB: rejected]
    K --> M{{EventBridge}}
    M --> N[TextractLambda\nDB: extracted]

    G --> O[Client polls /get-ticket]
    O -->|status: extracted| P[Review + edit fields in UI]
    P --> Q[POST /confirm-ticket]
    Q --> R[TicketDbConfirm\nDB: confirmed]
    R --> S{{EventBridge}}
    S --> T[TicketSheetsWriter\nDB: populated\nSheet row written]

    T --> U[Client polls /get-ticket]
    U -->|status: populated| V[Frontend reloads]

    V --> W[Admin: GET /tickets?status=populated]
    W --> X[POST /invoices/generate]
    X --> Y[InvoiceGenerator Lambda\nDB: generating invoice]
    Y --> Z[Google Apps Script\nPDF generated · uploaded to Drive]
    Z --> AA([DB: generated · PDF URL returned])
```

---

## Ticket Status Machine

```mermaid
stateDiagram-v2
    [*] --> awaiting_upload: TicketPresignHandler
    awaiting_upload --> uploaded: S3 trigger / TicketDbWriter
    uploaded --> validating: TicketValidator
    validating --> validated: passes validation
    validating --> rejected: fails uniqueness check
    validated --> extracting: TextractLambda
    extracting --> extracted: Textract success
    extracting --> failed: Textract failure
    extracted --> confirmed: client confirms
    confirmed --> populating: TicketSheetsWriter
    populating --> populated: Sheet write success
    populated --> generating_invoice: InvoiceGenerator
    generating_invoice --> invoiced: Apps Script success
    invoiced --> [*]
    rejected --> [*]
    failed --> [*]
```

---

## Auth

- Each driver has their own passcode; admin has a separate one
- Client submits passcode via POST to `/login` on API Gateway
- `TicketDriverLogin` Lambda validates the passcode and returns a signed JWT (crypto library)
- All downstream routes have a custom Lambda authorizer (`TicketJwtAuthorizer`) that validates the token

---

## Frontend Processing

Before upload, the client preprocesses the ticket image using OpenCV:

- Reject unsupported formats
- Convert to grayscale
- Reduce noise with Gaussian blur
- Edge detection (Canny)
- Morphological transform
- Contour detection and sorting
- Ticket area / image area ratio validation
- Find largest polygon and simplify to 4-point polygon
- Validate ticket width/height ratio
- Perspective transform
- Rotate if landscape

Client displays the processed image for preview before uploading.

---

## Raw Upload

1. Client sends POST to `/upload-ticket`
2. `TicketJwtAuthorizer` authorizes the request
3. `TicketPresignHandler` Lambda:
   - Grabs user identity from token
   - Generates a random `ticketId`
   - Creates a record in `ticket-db` with status `awaiting-upload`
   - Returns a presigned S3 PUT URL
4. Client PUTs image directly to S3 `/raw` using the presigned URL
5. Client begins polling `/get-ticket` (see [Client Polling](#client-polling))

---

## Cloud Validation and Extraction

### S3 Trigger → TicketDbWriter
- Triggered by new object in S3 `/raw`
- Fetches ticket record from DB
- Updates status to `uploaded` only if status === `awaiting-upload`
- On success: publishes event to EventBridge

### EventBridge → TicketValidator
- Updates status to `validating` only if status === `uploaded`
- Sets `validationStartedAt` timestamp (used by `TicketStageRecoveryLambda`)
- Downloads ticket from S3 `/raw`
- Verifies `.png` format
- Verifies file size
- TODO: verify aspect ratio
- TODO: verify blur index
- OCRs just the ticket number using Textract
- Checks ticket number uniqueness against `ccs-ticket-number-db` DynamoDB table
  - If uniqueness check fails: updates status to `rejected` only if status === `validating`
- TODO: normalize image size
- Sends PUT to S3 `/validated` or `/rejected`
- Updates status to `validated` or `rejected` only if status === `validating`
- On success: publishes `TicketExtractionRequested` event to EventBridge

### EventBridge → TextractLambda
- Updates status to `extracting` only if status === `validated`
- Sets `lastUpdated` timestamp (used by `TicketStageRecoveryLambda`)
- Loads ticket from S3 `/validated`
- Runs Textract
- Updates extracted data in `ticket-db`
- Updates status to `extracted` or `failed` only if status === `extracting`

---

## Client Polling

After the S3 PUT, the client polls `/get-ticket`:

- `TicketJwtAuthorizer` authorizes the token
- `TicketDbReader` Lambda:
  - Returns error if ticket doesn't exist
  - Returns error if `driverId` doesn't match requester
  - Returns current status (drives polling logic on client)
  - If status === `extracted`, also returns:
    - Extracted ticket data
    - Presigned GET URL for S3 `/validated`

---

## Client Ticket Review

1. Client receives extracted data + validated image URL
2. UI displays image with extracted fields, all editable
3. Driver reviews and edits fields
4. Client sends POST to `/confirm-ticket`
5. `TicketJwtAuthorizer` authorizes the token
6. `TicketDbConfirm` Lambda:
   - Updates DB with reviewed/edited data
   - DynamoDB transaction:
     - Updates status to `confirmed` only if status === `extracted`
     - Updates `ticket-number-db`
     - Stores calculated hours
   - On success: publishes event to EventBridge
7. Client polls `/get-ticket` until status === `populated`

---

## Google Sheets Population

### EventBridge → TicketSheetsWriter

> **Note:** Google Sheets is the business's source of truth. Tickets can be processed manually directly in Sheets. A planned **Sheets-sync Lambda** will run at the start of the pipeline to sync Sheets → Dynamo so the backend is aware of manually processed tickets.

- Updates status to `populating` only if status === `confirmed`
- Sets `populatingStartedAt` timestamp (used by `TicketStageRecoveryLambda`)
- Builds the new row in memory using this schema:

  | Col | Field        |
  |-----|--------------|
  | A   | Date         |
  | B   | Customer     |
  | C   | Job          |
  | D   | Ticket #     |
  | E   | Start Time   |
  | F   | End Time     |
  | G   | Hours        |
  | H   | Cashflow     |
  | I   | Invoice #    |
  | J   | Filed        |
  | K   | Paid         |
  | L   | Hourly Rate  |
  | M   | Driver       |
  | N   | Truck #      |

- Finds the next empty row under the Ticket # column
- Checks if the date in the previous row matches the current ticket's date
- Determines invoice # behavior:
  - `append to existing invoice` → reuse previous invoice #
  - `new invoice` → increment previous invoice # (format: `26DT###`)
- Populates: date, customer, job, ticket #, start, stop, invoice #, filed (checkbox = checked), driver, truck #
- Performs batch write
- DynamoDB transaction on success:
  - Updates status to `populated` in `ticket-db` only if status === `populating`
  - Updates status to `populated` in `ticket-number-db`

---

## Invoice Generation

### Admin View

- Admin sends GET to `/tickets?status=populated`
- `TicketDbReader` Lambda fetches all tickets with status `populated`
- Returns `confirmedData`, `confirmedAt`, `driverId`, `validatedKey`, and `status` per ticket
- UI shows badge if there are unprocessed tickets
- Admin groups tickets by earliest date, clicks "Generate Invoice"

### POST /invoices/generate → InvoiceGenerator Lambda

- Fetches all tickets from `ticket-db` with status === `populated` and matching date (using `status-date-index`)
- Single DynamoDB transaction: updates all matched tickets to `generating invoice` only if status === `populated`
- If any ticket fails the transition, Lambda exits with error (recovery Lambda planned)
- Calls Google Apps Script endpoint

### Apps Script

- Verifies request claims say `ADMIN`
- Fetches `sheetsRow` for each ticket
- Reads those rows from the Google Sheet
- Compares each field from Dynamo against Sheets to confirm they match
- Finds the lowest row number among the tickets and calculates the new invoice number by incrementing the previous one
- Feeds rows, invoice number, total hours, and total amount into an HTML template
- Generates a PDF and uploads to Google Drive
- Writes the new invoice number into the Sheet for those rows and links the PDF URL
- Returns success to Lambda with the PDF URL and invoice number

### InvoiceGenerator Lambda (continued)

- Receives PDF URL from Apps Script
- Updates `ticket-db`: sets `invoiceStatus` to `generated`, sets `invoiceNumber` and `InvoicePdfKey` only if `invoiceStatus` === `generating`
- Returns success to client with the PDF URL