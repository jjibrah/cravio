import { useState } from "react";
import { Link } from "react-router-dom";
const number = (value) =>
  Number(value).toLocaleString("en-KE", { maximumFractionDigits: 3 });
const name = (records, id) =>
  records.find((record) => record.id === id)?.name || "All locations";
const when = (value) =>
  new Date(value).toLocaleString("en-KE", {
    timeZone: "Africa/Nairobi",
    dateStyle: "medium",
    timeStyle: "short",
  });
export function Statistics({ items }) {
  return (
    <dl className="iv-statistics">
      {items.map(([label, value, detail]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
          <small>{detail}</small>
        </div>
      ))}
    </dl>
  );
}
export function Empty({ title, children, action, onAction }) {
  return (
    <div className="iv-empty-state">
      <h3>{title}</h3>
      <p>{children}</p>
      {action && (
        <button type="button" className="o-btn" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}
export function SetupSteps({ data, onView }) {
  const steps = [
    {
      name: "Create your workspace",
      detail: "Name the business whose stock you’ll track.",
      done: !!data.business,
    },
    {
      name: "Add the bakery and outlets",
      detail: "Keep each location’s stock separate.",
      done: data.locations.length > 0,
      view: "Locations",
    },
    {
      name: "Build your product catalogue",
      detail: "Use your existing SKUs and exact stock units.",
      done: data.products.length > 0,
      view: "Products",
    },
    {
      name: "Record starting stock",
      detail: "Enter a checked opening count or finished batch.",
      done: data.movements.length > 0,
      view: "Record",
    },
  ];
  return (
    <section className="iv-setup">
      <div>
        <h2>Start tracking your stock</h2>
        <p>
          {steps.filter((s) => s.done).length} of 4 steps complete. Your
          balances fill in as you record real activity.
        </p>
      </div>
      <ol>
        {steps.map((step, index) => (
          <li key={step.name}>
            <span className={step.done ? "iv-step is-done" : "iv-step"}>
              {step.done ? "Done" : index + 1}
            </span>
            <div>
              <strong>{step.name}</strong>
              <p>{step.detail}</p>
            </div>
            {!step.done && step.view && (
              <button
                type="button"
                className="o-btn"
                disabled={!data.business}
                onClick={() => onView(step.view)}
              >
                Continue
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
export function stockRows(data, scope = "") {
  return data.locations
    .filter((l) => !scope || l.id === scope)
    .flatMap((location) =>
      data.products.map((product) => {
        const quantity =
          data.balances.find(
            (b) => b.location_id === location.id && b.product_id === product.id,
          )?.quantity || "0";
        return {
          location,
          product,
          quantity,
          low:
            Number(product.low_stock) > 0 &&
            Number(quantity) <= Number(product.low_stock),
        };
      }),
    );
}
export function InventoryOverview({ data, Panel, Table, onView, scope }) {
  const rows = stockRows(data, scope);
  const pending = data.transfers.filter(
    (t) =>
      Number(t.remaining) > 0 &&
      (!scope || t.destination_id === scope || t.source_id === scope),
  );
  const low = rows.filter((r) => r.low);
  const scopedLocations = data.locations.filter(
    (l) => !scope || l.id === scope,
  );
  return (
    <>
      <Statistics
        items={[
          ["Locations", scopedLocations.length, "Stock is held separately"],
          ["Products", data.products.length, "Finished-product SKUs"],
          ["Open transfers", pending.length, "Awaiting receipt or resolution"],
          ["Low-stock lines", low.length, "Against your configured thresholds"],
        ]}
      />
      {!data.movements.length && <SetupSteps data={data} onView={onView} />}
      <div className="iv-columns">
        <Panel title="Needs attention">
          {!low.length && !pending.length ? (
            <Empty
              title={
                data.movements.length
                  ? "Nothing outstanding"
                  : "Your daily exceptions will appear here"
              }
            >
              {data.movements.length
                ? "There are no open transfers or configured low-stock alerts for this location selection."
                : "Record opening stock and deliveries to see shortages and outstanding transfers."}
            </Empty>
          ) : (
            <div className="iv-attention">
              {pending.slice(0, 4).map((t) => (
                <div key={t.id}>
                  <div>
                    <strong>
                      {number(t.remaining)} {name(data.products, t.product_id)}{" "}
                      unresolved
                    </strong>
                    <p>
                      {name(data.locations, t.source_id)} →{" "}
                      {name(data.locations, t.destination_id)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="o-btn"
                    onClick={() => onView("Transfers")}
                  >
                    Review transfer
                  </button>
                </div>
              ))}
              {low.slice(0, 4).map((r) => (
                <div key={`${r.location.id}-${r.product.id}`}>
                  <div>
                    <strong>
                      {r.product.name} is low at {r.location.name}
                    </strong>
                    <p>
                      {number(r.quantity)} {r.product.unit} on hand · threshold{" "}
                      {number(r.product.low_stock)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="o-btn"
                    onClick={() => onView("Stock")}
                  >
                    View stock
                  </button>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Daily workflow">
          <div className="iv-workflow">
            {[
              [
                "Record",
                "Record production",
                "Add finished output or a checked opening balance.",
              ],
              [
                "Transfers",
                "Dispatch and receive",
                "Review what left the bakery and what arrived.",
              ],
              [
                "Record",
                "Record sales and waste",
                "Keep the stock balance aligned with daily activity.",
              ],
              [
                "History",
                "Check the movement history",
                "Trace each posting back to its reference.",
              ],
            ].map(([view, title, detail], i) => (
              <button type="button" key={title} onClick={() => onView(view)}>
                <span>{i + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{detail}</p>
                </div>
                <span aria-hidden="true">→</span>
              </button>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title="Location overview">
        <Table
          heads={[
            "Location",
            "Type",
            "SKUs with stock",
            "Low-stock lines",
            "Open transfers",
          ]}
          rows={scopedLocations.map((l) => [
            l.name,
            l.kind,
            rows.filter((r) => r.location.id === l.id && Number(r.quantity) > 0)
              .length,
            low.filter((r) => r.location.id === l.id).length,
            pending.filter(
              (t) => t.source_id === l.id || t.destination_id === l.id,
            ).length,
          ])}
          empty="Add your production site and outlets to see their stock position."
        />
      </Panel>
      <Panel title="Recent activity">
        <Table
          heads={[
            "When",
            "Location",
            "Product",
            "Movement",
            "Quantity",
            "Reference",
          ]}
          rows={data.movements
            .filter((m) => !scope || m.location_id === scope)
            .slice(0, 5)
            .map((m) => [
              when(m.created_at),
              name(data.locations, m.location_id),
              name(data.products, m.product_id),
              m.kind,
              number(m.quantity),
              m.reason,
            ])}
          empty="Your first stock entry will appear here. No activity has been recorded yet."
        />
      </Panel>
    </>
  );
}
export function AssistantContent({ data, Panel, example }) {
  const [pending, low, openTasks] = [
    data.transfers.filter((t) => Number(t.remaining) > 0),
    stockRows(data).filter((r) => r.low),
    data.tasks.filter((t) => !t.completed_at),
  ];
  const facts = [
    {
      question: "Which transfers still need receiving?",
      answer: pending.length
        ? `${pending.length} transfer${pending.length === 1 ? "" : "s"} still have quantities outstanding. Review the delivery records before accepting goods or resolving a loss.`
        : "No transfers have outstanding quantities in this workspace.",
      href: "/owner/inventory?view=Transfers",
    },
    {
      question: "Where is stock running low?",
      answer: low.length
        ? `${low.length} location/product line${low.length === 1 ? " is" : "s are"} at or below a configured threshold. Check the stock view before planning a delivery.`
        : "No stock lines are below a configured positive threshold. Set product thresholds to make this check useful.",
      href: "/owner/inventory?view=Stock",
    },
    {
      question: "What work is still open?",
      answer: `${openTasks.length} task${openTasks.length === 1 ? " is" : "s are"} open in the most recent 200 checklist records. Check their dates and locations before closing the day.`,
      href: "/owner/management",
    },
  ];
  const [chosen, setChosen] = useState(0);
  return (
    <>
      <div className="iv-ai-status">
        <span className="iv-status">
          AI placeholder · OpenRouter not connected
        </span>
        <p>
          Explore the briefing structure using recorded facts. Generated answers
          and menu extraction become available when OpenRouter is configured.
        </p>
      </div>
      <div className="iv-columns">
        <Panel title="Owner briefing">
          <p className="iv-muted">
            {example
              ? "Example records for exploring this page."
              : "Current inventory records."}{" "}
            Updated {when(data.asOf)}. Manual sales coverage only.
          </p>
          <ul className="iv-briefing">
            {facts.map((f) => (
              <li key={f.question}>
                <strong>{f.question}</strong>
                <p>{f.answer}</p>
                <Link
                  className="o-text-link"
                  to={
                    f.href +
                    (example
                      ? (f.href.includes("?") ? "&" : "?") + "example=1"
                      : "")
                  }
                >
                  Open source records
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Ask about your business">
          <p className="iv-muted">
            These quick questions show a direct lookup of your records. They are
            not AI-generated answers.
          </p>
          <div className="iv-questions">
            {facts.map((f, i) => (
              <button
                className={`o-btn${chosen === i ? " is-selected" : ""}`}
                type="button"
                key={f.question}
                onClick={() => setChosen(i)}
              >
                {f.question}
              </button>
            ))}
          </div>
          <div className="iv-answer" role="status">
            <strong>Recorded facts</strong>
            <p>{facts[chosen].answer}</p>
            <Link
              className="o-text-link"
              to={
                facts[chosen].href +
                (example
                  ? (facts[chosen].href.includes("?") ? "&" : "?") + "example=1"
                  : "")
              }
            >
              View supporting records
            </Link>
          </div>
          <p className="iv-muted">
            No model calls are made. Forecasts and ingredient-margin advice are
            not available.
          </p>
        </Panel>
      </div>
      <Panel title="Menu import">
        <div className="iv-import-layout">
          <div>
            <h3>Review a menu before it goes live</h3>
            <p>
              Planned flow: upload a photo or PDF, check extracted dishes and
              prices against the original, then approve publication.
            </p>
            <p className="iv-muted">
              Extraction is not connected yet. Your existing menu editor is
              available for manual changes.
            </p>
            <Link className="o-btn" to="/owner/products">
              Open products
            </Link>
          </div>
          <ol className="iv-import-steps">
            <li>Upload your source menu</li>
            <li>Review categories, dishes and prices</li>
            <li>Correct uncertain fields</li>
            <li>Approve and publish</li>
          </ol>
        </div>
      </Panel>
    </>
  );
}
