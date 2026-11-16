# Fayaz discovery meeting: stock, branches and daily operations

Purpose: agree how Cravio should track finished cakes/pastries from the main bakery to each outlet while Fayaz keeps its existing POS. Ingredients, recipe costing and POS replacement are future discovery topics unless the scope is explicitly changed.

Confirmed before this meeting: start with finished products and branch stock. Everything else below is a question, not an assumed SOP.

Meeting date: ____________________

Participants and roles: ____________________

Decision maker / pilot owner: ____________________

Notes and evidence location: ____________________

Ask the owner, bakery/dispatch operator, an outlet receiver/supervisor and the person responsible for POS/reports to participate. Invite the accountant or existing-system vendor for the relevant sections. Have an actual dispatch note and matching sales/stock report available.

## How to use this guide

Start by asking: **"Please walk us through yesterday, from the first finished batch at the bakery to the last stock count at an outlet. Show us the records you used."** Follow one real product and one real delivery throughout the discussion. Ask what happens when things go wrong, not only on a normal day.

If time is short, prioritize Q01, Q04, Q07, Q10, Q15, Q20–Q24, Q26–Q30, Q36–Q40, Q50 and Q58–Q61. Send remaining sections to the staff member who owns the process.

For each answer record: current practice; desired change; responsible role; example/document; decision or unresolved follow-up. An absent SOP is a finding—do not invent one during the meeting.

## A. Business structure and the problem to solve

- **Q01.** Which locations exist today, and what does each do: production, storage, sales, or a combination? Please provide their names and identify the main bakery.
- **Q02.** Are all locations owned by the same legal business, or are any franchises/separate businesses? Are goods transferred internally or invoiced between businesses?
- **Q03.** Does any outlet also produce, decorate, slice or repackage products? Can outlets supply each other or receive directly from suppliers?
- **Q04.** What are the three most costly or frustrating problems with the current system? Show a recent example and explain what information was missing.
- **Q05.** Which existing functions must the replacement preserve? Which screens, reports or procedures do staff depend on even if the system is outdated?
- **Q06.** Which bakery/outlets and product groups should participate in the first pilot? What are normal and busiest-day volumes of products, deliveries, sales and users?

Answers/evidence: ____________________

Development decisions: business/location model; legal boundary of transfers; pilot scale; must-preserve workflows. Plan D01.

## B. Products, quantities and catalogue ownership

- **Q07.** Can you provide your current product list with item codes/barcodes, names, variants and units? Are the same codes used at every outlet and in the POS?
- **Q08.** Which differences make a separate stock item: flavour, cake size, weight, decoration, packaging or something else? Are custom cakes uniquely identified?
- **Q09.** What units are used when producing, dispatching, receiving, counting and selling each product? Are trays/boxes fixed quantities or variable?
- **Q10.** Are whole cakes sold as slices? Where and when is a cake cut, how many saleable slices result, and how are damaged/offcut pieces recorded? Show a real example.
- **Q11.** Are there mixed boxes, bundles, complimentary items, staff meals or promotions? How should each reduce stock? Are display samples and reserved custom orders still counted as available?
- **Q12.** Who can create/change products and units? Are prices different by outlet? Which system should control product codes, prices and menu descriptions?

Answers/evidence: ____________________

Development decisions: SKU identity, unit conversions, transformations, bundles and ownership of catalogue data. Plan D02.

## C. Finished production and opening stock

- **Q13.** Who records finished output, at what point, and using which document or device? Is output recorded per batch, shift or day?
- **Q14.** Is the recorded quantity what was planned or what actually passed inspection? How are rejected pieces, samples and rework recorded before dispatch?
- **Q15.** What production/batch/date labels already exist? Can the same product have several batches on one delivery, and must an outlet identify which batch it sells?
- **Q16.** What shelf-life, storage-condition, expiry or sell-by rules apply to each product? Who defines and may override them? Are products discounted, returned or discarded near expiry?
- **Q17.** How will we establish opening stock at the bakery and outlets? Can staff perform a signed physical count, including goods in transit, reserved goods and damaged/held stock?
- **Q18.** Who verifies production entries and opening balances? What happens if an entry is wrong or arrives late, and should approval be required for corrections?

Answers/evidence: ____________________

Development decisions: finished-output entry, batch granularity, saleable status, opening balances and correction permissions. Plan D03–D04.

## D. Outlet requests, dispatch, transport and receiving

- **Q19.** Who decides what each outlet receives: outlet requests, head-office allocation, fixed schedules or another method? What happens when requests exceed available stock?
- **Q20.** Walk us through preparing and sending a delivery. Who picks, counts, approves, signs and transports it? When does stock officially leave the bakery?
- **Q21.** What proof accompanies a delivery: paper note, WhatsApp message, signature, photo, barcode or existing-system record? Does every delivery have a unique reference?
- **Q22.** At the outlet, who physically counts and accepts the goods? Can the receiver record a different quantity from what was sent? Are receivers independent of dispatchers?
- **Q23.** If 50 pastries are sent and 47 arrive, what happens today? Who investigates the missing three, what evidence is required, and who closes the discrepancy? How are excess or damaged goods handled?
- **Q24.** Can a shipment arrive in parts, go to the wrong outlet, be refused or return to the bakery? Who may cancel or redirect it after dispatch? How should goods still travelling overnight appear?
- **Q25.** Can outlets send products to one another or return unsold stock? Who decides whether returned food can be sold again, held for inspection or discarded?

Answers/evidence: ____________________

Ask to see one normal delivery and one disputed/partial delivery with all related records.

Development decisions: transfer states, transit ownership, partial receipts, discrepancies, proof and reverse logistics. Plan D04–D05.

## E. Current POS and sales data — critical integration questions

- **Q26.** What is the exact name, vendor and version of the POS/stock system at each location? Is it installed locally or hosted? Who owns the vendor relationship?
- **Q27.** Can it export sales quantities by product, outlet and date/time? Please show an actual export with its column headings, including item codes and transaction/receipt IDs if available.
- **Q28.** Does the vendor offer an API, webhooks, sandbox or scheduled exports? Are access, support or integration fees required? Can we speak directly with their technical contact?
- **Q29.** Which sale event should reduce stock: order entry, fulfilment, payment or end-of-day posting? How are unpaid orders, preorders, deposits, cancellations, voids and refunds handled?
- **Q30.** Do exports distinguish quantities sold, returned, voided, discounted and given away? Are they transaction-level, daily totals or cumulative totals that change on later exports?
- **Q31.** Which channels exist: counter, dine-in, custom cakes, delivery platforms, WhatsApp, website, catering or wholesale? Does the POS capture every channel, or would some sales be missing?
- **Q32.** How quickly does stock need to update for decisions: immediately, at intervals or once per day? If integration is unavailable, who can export/import or enter sales, and how much work is acceptable?
- **Q33.** Can we obtain redacted sample exports covering a normal day, refunds/cancellations, a corrected export, different outlets and a busy day? Who is authorized to approve development access?

Do not collect passwords, API keys or customer payment details in these notes. Arrange a secure access method later. Ask for redacted records while preserving useful item/transaction relationships.

Answers/evidence: ____________________

Development decisions: API vs CSV vs manual entry, update frequency, sale authority, mapping, deduplication and correction handling. Plan D06–D07.

## F. Waste, returns, counts and day-end control

- **Q34.** What types of loss must be tracked separately: expiry, transport damage, handling damage, samples, staff consumption, theft allegation, quality rejection or unknown shortage? Which are relevant to your actual process?
- **Q35.** Who records waste and customer returns? What evidence/approval is needed? Does a refund ever restore stock, and who confirms that the returned item is safe and saleable?
- **Q36.** When and how is stock physically counted: daily, per shift, weekly or by product group? Who counts and who checks it? Do staff see the system's expected quantity before counting?
- **Q37.** Do sales or transfers continue during counting? If so, how are movements between the count and closing handled? What is your business-day cut-off, including trading after midnight?
- **Q38.** If physical stock differs from expected stock, who investigates and approves the adjustment? Are there thresholds for additional approval? What happens if a correction relates to a closed day?
- **Q39.** What stock may be negative, if any? Are backdated entries permitted? What is the process for a missing production entry or a late sales import?
- **Q40.** What must the owner see at day end? Please rank stock balances, unsold quantities, waste, transfer discrepancies, missing sales, unpaid orders and branch comparisons. Show the report you use now.

Answers/evidence: ____________________

Development decisions: loss categories, count cut-off, negative stock, backdating, close/reopen rules and management reports. Plan D07–D08.

## G. Staff access, approvals and accountability

- **Q41.** Which roles need access: owner, head-office manager, production staff, dispatcher, driver, outlet supervisor, cashier, waiter or accountant? Which locations and actions should each role access?
- **Q42.** Who may approve transfers, accept receipts, post waste, change counts, correct history, edit products and export reports? Can a person approve their own action, or must someone else approve it?
- **Q43.** Do staff share devices/accounts or work across outlets? How should handovers, temporary cover, lost devices and departing staff be handled? What history must remain visible to managers?

Suggested permission worksheet—fill in actual role names, do not assume them:

| Action | Can enter | Can approve | Can view | Location scope |
| --- | --- | --- | --- | --- |
| Record finished output | | | | |
| Dispatch a transfer | | | | |
| Receive a transfer | | | | |
| Resolve a discrepancy | | | | |
| Import/post sales | | | | |
| Record waste/returns | | | | |
| Count/adjust stock | | | | |
| Create products/units | | | | |
| Close/reopen a day | | | | |

Development decisions: role grants, separation of duties, approvals and audit visibility. Plan D04, D08.

## H. Optional restaurant service and management

These questions determine whether to include service features at Fayaz. They are not requirements for inventory-only adoption.

- **Q44.** Which outlets use table service, and which only sell over the counter? Would they use Cravio's guest menu/waiter tools now, later or not at all?
- **Q45.** How do confirmed orders reach the kitchen/bar today? Which screens/printers/stations exist? What must happen before an order is prepared, ready, collected and served?
- **Q46.** Would sending Cravio orders to the POS remove work, or create duplicate tickets? Which system should own kitchen routing and checkout while both run?
- **Q47.** How are tables assigned, service requests escalated and shifts handed over? Which approvals/reasons are needed for cancelling an order or changing a bill?
- **Q48.** What opening/closing checklists exist? Who completes and verifies them, how often, and what should happen if a required task is missed?
- **Q49.** Which menu choices are required (size, side, flavour), which menus run at particular times, and what verified allergen/dietary/translation information exists? Who approves guest-facing content?

Answers/evidence: ____________________

Development decisions: whether Service is in the pilot, station routing, task ownership, menu rules and content approval. Plan D09.

## I. Devices, connectivity and working conditions

- **Q50.** What devices, operating systems and browsers can dispatch and outlet staff actually use? Are they shared? Can we test on those devices at both locations?
- **Q51.** How often do internet or power outages happen, and how long do they last? Which actions must continue during an outage, and what paper/manual fallback is acceptable?
- **Q52.** Are printers, barcode scanners, labels or cameras required? What exact models and connection types are already installed? Is delivery proof required without a network connection?
- **Q53.** Which languages, accessibility needs and training constraints should we design for? How much time can receiving/counting take before it disrupts work?

Answers/evidence: ____________________

Development decisions: offline scope, hardware support, mobile flows, training and measurable usability. Plan D10.

## J. AI assistance and information handling

Cravio's intended provider is OpenRouter; the initial implementation will use labelled placeholders until real AI is configured. Do not promise live predictions during the inventory pilot.

- **Q54.** Which three questions would the owner most like the system to answer each day? Give examples from recent decisions about stock, waste, transfers or sales.
- **Q55.** Would a daily briefing, document/menu import or replenishment suggestion save the most work? Who would review it, and which actions must always require approval?
- **Q56.** What business/staff/customer data may be processed by external AI services? Who can approve that use, what retention restrictions apply, and what information must remain excluded?
- **Q57.** What would make an AI suggestion trustworthy: linked records, explanations, uncertainty, source documents or manager review? How will we decide whether it is useful and sufficiently accurate?

Product-owner follow-up: choose model(s), permitted provider routing, budget/caps and retention settings before real OpenRouter calls. These are still open decisions.

Answers/evidence: ____________________

Development decisions: AI use cases, evidence expectations, human review and data policy. Plan D11.

## K. Pilot, migration, acceptance and commercial scope

- **Q58.** Who is the named pilot owner and who represents bakery, outlet and finance staff? Who can approve SOP changes and accept the finished system?
- **Q59.** Which locations/products should pilot first, during what operating period, and for how long should old and new records run in parallel? Are there peak periods we must avoid?
- **Q60.** What must pass before rollout? Agree concrete measures: stock reconciliation, resolved delivery differences, time spent receiving/counting, report timeliness and staff completion. Establish today's baseline before setting targets.
- **Q61.** What data/history must migrate? Who will clean product codes, verify opening counts and sign off? What fallback would you use if the pilot became unavailable?
- **Q62.** What budget, support hours, response expectations, training and hardware costs can the business support? Which requests are essential to launch and which can wait?
- **Q63.** Who signs off scope, ongoing subscription and future changes? What is the process for prioritizing new requests once the pilot begins?

Answers/evidence: ____________________

Development decisions: acceptance criteria, release boundaries, migration ownership, support and business viability. Plan D12–D13.

## Documents and demonstrations to request

- [ ] Location list and relevant ownership structure.
- [ ] Product catalogue with codes, units, variants and pack sizes.
- [ ] Current SOPs, opening/closing checklists and responsibility chart, if they exist.
- [ ] Finished-production/batch sheet and labels.
- [ ] Dispatch note plus matching receipt, including a shortage/partial/damaged example.
- [ ] Waste/return log and stock-count/adjustment sheet.
- [ ] Actual POS sales exports, including corrections/refunds and outlet identifiers.
- [ ] POS vendor/version, technical contact and integration/export documentation.
- [ ] Current owner/finance reports and a walkthrough of their calculations.
- [ ] Device/printer/scanner models and an on-site connectivity demonstration.
- [ ] Named pilot participants and draft acceptance measures.

Redact customer identities, payment details and unnecessary staff personal data. Preserve product IDs, units and relationships required to understand the workflow. Do not put credentials into this file.

## End-of-meeting decisions and follow-ups

Read the agreed workflow back to the participants: **finished output → dispatch → transit → receipt → sales/waste/returns → physical count → review.** Confirm deviations explicitly.

| Decision / question IDs | Agreed answer or still open | Evidence | Responsible person | Due date |
| --- | --- | --- | --- | --- |
| Pilot scope and locations | | | | |
| Product units and cake/slice handling | | | | |
| Sales source and update frequency | | | | |
| Receipt discrepancies and returns | | | | |
| Roles and approvals | | | | |
| Counts, cut-off and corrections | | | | |
| Offline needs and devices | | | | |
| AI scope and permitted data | | | | |
| Acceptance and rollout | | | | |

Record changes to the implementation plan using these answers. Unknowns stay marked open; neither a proposed workflow nor silence constitutes Fayaz's approval.
