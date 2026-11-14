import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/dashboard/PageFrame";
import { api, useApi } from "../../lib/api";
import { useNotifications } from "../../components/notifications/NotificationProvider";
import "../../components/owner/owner.css";
import "./inventory.css";
import { exampleWorkspace } from "./example-workspace";
import {
  InventoryOverview,
  AssistantContent,
  Statistics,
  stockRows,
} from "./WorkspaceContent";

const labels = {
  opening: "Opening balance",
  output: "Finished production",
  sale: "Manual sale",
  waste: "Waste",
  dispatch: "Dispatch",
  count: "Physical count",
  receive: "Receive transfer",
  transit_loss: "Resolve transit loss",
};
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const date = (value) =>
  new Date(value).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" });
const qty = (value) =>
  Number(value).toLocaleString("en-KE", { maximumFractionDigits: 3 });
function Field({
  name,
  label,
  options,
  type = "text",
  required = true,
  defaultValue,
  value,
  ...props
}) {
  const id = `inventory-${name}`;
  return (
    <div className="iv-field">
      <label htmlFor={id}>{label}</label>
      {options ? (
        <select
          id={id}
          name={name}
          required={required}
          {...(value !== undefined
            ? { value }
            : { defaultValue: defaultValue ?? "" })}
          {...props}
        >
          <option value="" disabled={required}>
            Choose…
          </option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          name={name}
          type={type}
          required={required}
          {...(value !== undefined ? { value } : { defaultValue })}
          {...props}
        />
      )}
    </div>
  );
}
function Panel({ title, children }) {
  return (
    <section className="o-panel">
      <header className="o-panel-head">
        <h2 className="o-panel-title">{title}</h2>
      </header>
      <div className="o-panel-body">{children}</div>
    </section>
  );
}
function Table({ heads, rows, empty }) {
  return (
    <div className="iv-scroll">
      <table className="iv-table">
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={heads.length} className="iv-empty">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function InventoryPage({ section }) {
  const {
    data: response,
    error,
    loading,
    refresh,
  } = useApi("/api/inventory", { ttl: 5000 });
  const { notify } = useNotifications();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const example = params.get("example") === "1";
  const data = example
    ? exampleWorkspace
    : response
      ? {
          business: null,
          locations: [],
          products: [],
          balances: [],
          transfers: [],
          movements: [],
          tasks: [],
          asOf: new Date().toISOString(),
          ...response,
        }
      : null;
  const [scope, setScope] = useState("");
  const [search, setSearch] = useState("");
  const [stockStatus, setStockStatus] = useState("all");
  const [taskDay, setTaskDay] = useState(today());
  const [taskStatus, setTaskStatus] = useState("all");
  const tabs = [
    "Overview",
    "Stock",
    "Locations",
    "Products",
    "Record",
    "Transfers",
    "History",
  ];
  const requested = params.get("view");
  const tab = tabs.includes(requested) ? requested : "Overview";
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [movement, setMovement] = useState("output");
  const [location, setLocation] = useState("");
  const [product, setProduct] = useState("");
  const request = useRef(null);
  const countBasis = useRef(null);
  const submit = (action) => async (event) => {
    event.preventDefault();
    if (busy || example) return;
    const form = event.currentTarget;
    const body = { action, ...Object.fromEntries(new FormData(form)) };
    if (action === "movement") {
      body.action = movement;
      if (movement === "count")
        body.expectedBalance =
          countBasis.current?.balance ??
          data.balances.find(
            (b) =>
              b.location_id === body.locationId &&
              b.product_id === body.productId,
          )?.quantity ??
          "0";
    }
    const signature = JSON.stringify(body);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    body.commandId = request.current.id;
    setBusy(true);
    setFailure("");
    try {
      await api("/api/inventory", { method: "POST", body });
      request.current = null;
      countBasis.current = null;
      if (!["movement", "complete_task"].includes(action)) form.reset();
      await refresh();
      notify("Changes recorded");
    } catch (e) {
      setFailure(e.message);
    } finally {
      setBusy(false);
    }
  };
  const locations = data?.locations || [],
    products = data?.products || [];
  const locationName = (id) => locations.find((x) => x.id === id)?.name || "—";
  const productName = (id) => products.find((x) => x.id === id)?.name || "—";
  const balance = (l, p) =>
    data?.balances?.find((b) => b.location_id === l && b.product_id === p)
      ?.quantity || "0";
  const transfers = data?.transfers || [];
  const unresolved = transfers.filter((t) => Number(t.remaining) > 0);
  const onView = (view) => {
    setFailure("");
    setScope("");
    setSearch("");
    if (section.path === "inventory")
      setParams((previous) => {
        previous.set("view", view);
        return previous;
      });
    else
      navigate(`/owner/inventory?view=${view}${example ? "&example=1" : ""}`);
  };
  const toggleExample = () => {
    setScope("");
    setSearch("");
    setParams((previous) => {
      if (example) previous.delete("example");
      else previous.set("example", "1");
      return previous;
    });
  };
  const visibleStock = data
    ? stockRows(data, scope).filter(
        (r) =>
          (stockStatus !== "low" || r.low) &&
          `${r.product.name} ${r.product.sku} ${r.location.name}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      )
    : [];
  const visibleTasks = (data?.tasks || []).filter(
    (t) =>
      (!scope || t.location_id === scope) &&
      (!taskDay || String(t.day).slice(0, 10) === taskDay) &&
      (taskStatus === "all" ||
        (taskStatus === "open" ? !t.completed_at : !!t.completed_at)),
  );
  const button = (label = "Record") => (
    <button
      className="o-btn is-primary"
      disabled={
        busy || example || (!data?.business && label !== "Create workspace")
      }
    >
      {busy ? "Saving…" : label}
    </button>
  );
  const selection = (
    <>
      <Field
        name="locationId"
        label="Location"
        options={locations}
        onChange={(e) => {
          setLocation(e.target.value);
          countBasis.current = null;
        }}
      />
      <Field
        name="productId"
        label="Product"
        options={products}
        onChange={(e) => {
          setProduct(e.target.value);
          countBasis.current = null;
        }}
      />
    </>
  );
  return (
    <div className="iv-page">
      <PageHeader title={section.label} description={section.description}>
        <button type="button" className="o-btn" onClick={toggleExample}>
          {example ? "Use my workspace" : "Explore example"}
        </button>
        <button
          type="button"
          className="o-btn"
          onClick={refresh}
          disabled={busy || example}
        >
          Refresh
        </button>
      </PageHeader>
      {error && !example && (
        <div className="iv-notice" role="alert">
          {error.message}{" "}
          <button className="o-btn" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {failure && (
        <div className="iv-notice" role="alert">
          {failure}
        </div>
      )}
      {loading && !example && <p role="status">Loading your business…</p>}
      {data && !data.business && (
        <Panel title="Set up inventory">
          <p className="iv-muted">
            Create an inventory workspace for your account. Add your real
            locations and product units; start with a checked opening balance.
            You can also explore the read-only example before setting up.
          </p>
          <form className="iv-form iv-setup-form" onSubmit={submit("setup")}>
            <Field name="name" label="Business name" maxLength={160} />
            {button("Create workspace")}
          </form>
        </Panel>
      )}
      {data && (
        <>
          {example && (
            <div className="iv-example" role="status">
              <strong>Read-only example workspace</strong>
              <span>
                Fictional records for exploring the page. Nothing here is saved
                or connected to Fayaz.
              </span>
              <button type="button" className="o-btn" onClick={toggleExample}>
                Back to my workspace
              </button>
            </div>
          )}
          <div className="iv-context">
            <strong>
              {data.business?.name || "Workspace not yet created"}
            </strong>
            <span>
              {example ? "Example records" : "Manually recorded stock"} ·{" "}
              {date(data.asOf)}
            </span>
          </div>
          {section.path === "inventory" && (
            <>
              <nav className="o-segmented" aria-label="Inventory views">
                {tabs.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`o-segment${tab === t ? " is-selected" : ""}`}
                    aria-current={tab === t ? "page" : undefined}
                    onClick={() => onView(t)}
                  >
                    {t}
                  </button>
                ))}
              </nav>
              {["Overview", "Stock"].includes(tab) && (
                <div className="iv-toolbar">
                  <Field
                    name="scope"
                    label="Filter location"
                    options={[
                      { id: "all", name: "All locations" },
                      ...locations,
                    ]}
                    value={scope || "all"}
                    onChange={(e) =>
                      setScope(e.target.value === "all" ? "" : e.target.value)
                    }
                  />
                  <div className="iv-toolbar-actions">
                    <button
                      type="button"
                      className="o-btn"
                      disabled={!data.business}
                      onClick={() => onView("Record")}
                    >
                      Record movement
                    </button>
                    <button
                      type="button"
                      className="o-btn"
                      onClick={() => onView("Transfers")}
                    >
                      View transfers
                    </button>
                  </div>
                </div>
              )}
              {tab === "Overview" && (
                <InventoryOverview
                  data={data}
                  Panel={Panel}
                  Table={Table}
                  onView={onView}
                  scope={scope}
                />
              )}
              {tab === "Stock" && (
                <Panel title="Stock by location">
                  <p className="iv-muted">
                    As of {date(data.asOf)}. Sales are manual entries; this
                    balance is not connected to the POS. Low-stock thresholds
                    are configured per product.
                  </p>
                  <div className="iv-toolbar">
                    <Field
                      name="search"
                      label="Search stock"
                      type="search"
                      required={false}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Product, SKU or location"
                    />
                    <Field
                      name="stockStatus"
                      label="Stock status"
                      options={[
                        { id: "all", name: "All stock" },
                        { id: "low", name: "Low stock only" },
                      ]}
                      value={stockStatus}
                      onChange={(e) => setStockStatus(e.target.value)}
                    />
                  </div>
                  <Table
                    heads={[
                      "Location",
                      "Product",
                      "On hand",
                      "Unit",
                      "Attention",
                    ]}
                    rows={visibleStock.map((r) => [
                      r.location.name,
                      r.product.name,
                      qty(r.quantity),
                      r.product.unit,
                      r.low ? (
                        <span className="iv-status is-warning">Low stock</span>
                      ) : Number(r.product.low_stock) > 0 ? (
                        "Within threshold"
                      ) : (
                        "No threshold set"
                      ),
                    ])}
                    empty="Add locations and products to start tracking stock."
                  />
                </Panel>
              )}
              {tab === "Locations" && (
                <Panel title="Locations">
                  <form className="iv-form" onSubmit={submit("location")}>
                    <Field name="name" label="Location name" maxLength={160} />
                    <Field
                      name="kind"
                      label="Type"
                      options={[
                        { id: "bakery", name: "Bakery / production" },
                        { id: "outlet", name: "Sales outlet" },
                        { id: "warehouse", name: "Warehouse" },
                      ]}
                    />
                    {button("Add location")}
                  </form>
                  <Table
                    heads={["Location", "Type"]}
                    rows={locations.map((l) => [l.name, l.kind])}
                    empty="Add the bakery and each outlet separately."
                  />
                </Panel>
              )}
              {tab === "Products" && (
                <Panel title="Finished products">
                  <p className="iv-muted">
                    Choose one base unit for each SKU. Enter quantities in that
                    unit throughout. Tray-to-piece and cake-to-slice conversions
                    are not automated in this preview.
                  </p>
                  <form className="iv-form" onSubmit={submit("product")}>
                    <Field
                      name="sku"
                      label="SKU / product code"
                      maxLength={60}
                    />
                    <Field name="name" label="Product name" maxLength={160} />
                    <Field
                      name="unit"
                      label="Base unit (for example, piece)"
                      maxLength={30}
                    />
                    <Field
                      name="lowStock"
                      label="Low-stock threshold"
                      type="number"
                      min="0"
                      max="999999999"
                      step="0.001"
                      defaultValue="0"
                    />
                    {button("Add product")}
                  </form>
                  <Table
                    heads={["SKU", "Product", "Base unit", "Threshold"]}
                    rows={products.map((p) => [
                      p.sku,
                      p.name,
                      p.unit,
                      qty(p.low_stock),
                    ])}
                    empty="Add a finished product to begin."
                  />
                </Panel>
              )}
              {tab === "Record" && (
                <Panel title="Record a stock movement">
                  <p className="iv-muted">
                    Every posting is saved with your account, time and
                    reference. Negative stock is blocked. Sales recorded here do
                    not change Cravio orders or mark bills paid.
                  </p>
                  <form className="iv-form" onSubmit={submit("movement")}>
                    <Field
                      name="kind"
                      label="Movement"
                      options={[
                        "opening",
                        "output",
                        "sale",
                        "waste",
                        "dispatch",
                        "count",
                      ].map((id) => ({ id, name: labels[id] }))}
                      value={movement}
                      onChange={(e) => {
                        setMovement(e.target.value);
                        countBasis.current = null;
                      }}
                    />
                    {selection}
                    {movement === "dispatch" && (
                      <Field
                        name="destinationId"
                        label="Destination"
                        options={locations.filter((l) => l.id !== location)}
                      />
                    )}
                    <Field
                      name="quantity"
                      label={
                        movement === "count"
                          ? "Physical quantity counted"
                          : "Quantity in product base units"
                      }
                      onFocus={() => {
                        if (movement === "count" && !countBasis.current)
                          countBasis.current = {
                            balance: balance(location, product),
                          };
                      }}
                      type="number"
                      min={movement === "count" ? "0" : "0.001"}
                      max="999999999"
                      step="0.001"
                    />
                    <Field
                      name="reason"
                      label="Reference / reason"
                      maxLength={500}
                    />
                    {movement === "output" && (
                      <>
                        <Field
                          name="batch"
                          label="Batch reference (optional)"
                          required={false}
                        />
                        <Field
                          name="expiresOn"
                          label="Expiry date (optional)"
                          type="date"
                          required={false}
                        />
                      </>
                    )}
                    {location && product && (
                      <p className="iv-muted">
                        Current recorded balance:{" "}
                        {qty(balance(location, product))}{" "}
                        {products.find((p) => p.id === product)?.unit}.{" "}
                        {movement === "count"
                          ? "Submitting replaces the expected balance with your physical count and records the difference. Count while movements are paused."
                          : ""}
                      </p>
                    )}
                    {movement === "count" && (
                      <label className="iv-check">
                        <input type="checkbox" required />I have checked the
                        physical count and approve posting its difference.
                      </label>
                    )}
                    {button("Post movement")}
                  </form>
                </Panel>
              )}
              {tab === "Transfers" && (
                <>
                  <Panel title="Dispatched stock">
                    <p className="iv-muted">
                      A dispatch reduces source stock. Only confirmed receipts
                      increase destination stock. Outstanding quantities remain
                      in transit until received or explicitly recorded as loss.
                    </p>
                    <Table
                      heads={[
                        "Sent",
                        "From → to",
                        "Product",
                        "Sent quantity",
                        "Received",
                        "Transit loss",
                        "Unresolved",
                      ]}
                      rows={transfers.map((t) => [
                        date(t.created_at),
                        `${locationName(t.source_id)} → ${locationName(t.destination_id)}`,
                        productName(t.product_id),
                        qty(t.quantity),
                        qty(t.received),
                        qty(t.lost),
                        qty(t.remaining),
                      ])}
                      empty="Record a dispatch to create a transfer."
                    />
                  </Panel>
                  <Panel title="Receive or resolve">
                    <form className="iv-form" onSubmit={submit("transfer")}>
                      <Field
                        name="action"
                        label="Action"
                        options={["receive", "transit_loss"].map((id) => ({
                          id,
                          name: labels[id],
                        }))}
                      />
                      <Field
                        name="transferId"
                        label="Outstanding transfer"
                        options={unresolved.map((t) => ({
                          id: t.id,
                          name: `${locationName(t.source_id)} → ${locationName(t.destination_id)} · ${productName(t.product_id)} · ${qty(t.remaining)} unresolved`,
                        }))}
                      />
                      <Field
                        name="quantity"
                        label="Quantity to receive / record as lost"
                        type="number"
                        min="0.001"
                        step="0.001"
                      />
                      <Field
                        name="reason"
                        label="Receipt reference / loss reason"
                        maxLength={500}
                      />
                      {button("Confirm")}
                    </form>
                  </Panel>
                </>
              )}
              {tab === "History" && (
                <Panel title="Movement history">
                  <p className="iv-muted">
                    Most recent 200 posted entries. Batch and expiry fields
                    record production provenance; batch-level depletion and
                    expiry availability are future work.
                  </p>
                  <Table
                    heads={[
                      "When",
                      "Location",
                      "Product",
                      "Action",
                      "Quantity",
                      "Reference",
                      "Batch",
                      "Actor",
                    ]}
                    rows={data.movements.map((m) => [
                      date(m.created_at),
                      locationName(m.location_id),
                      productName(m.product_id),
                      labels[m.kind],
                      qty(m.quantity),
                      m.reason,
                      m.batch || "—",
                      m.actor_id,
                    ])}
                    empty="Posted movements will appear here."
                  />
                </Panel>
              )}
            </>
          )}
          {section.path === "management" && (
            <>
              <Statistics
                items={[
                  [
                    "Tasks in view",
                    visibleTasks.length,
                    "For the selected date and location",
                  ],
                  [
                    "Open",
                    visibleTasks.filter((t) => !t.completed_at).length,
                    "Still to complete",
                  ],
                  [
                    "Completed",
                    visibleTasks.filter((t) => t.completed_at).length,
                    "Completion is timestamped",
                  ],
                  [
                    "Outstanding deliveries",
                    unresolved.length,
                    "Review before closing",
                  ],
                ]}
              />
              <div className="iv-toolbar">
                <Field
                  name="taskScope"
                  label="Filter task location"
                  options={[{ id: "all", name: "All locations" }, ...locations]}
                  value={scope || "all"}
                  onChange={(e) =>
                    setScope(e.target.value === "all" ? "" : e.target.value)
                  }
                />
                <Field
                  name="taskDay"
                  label="Filter task date"
                  type="date"
                  required={false}
                  value={taskDay}
                  onChange={(e) => setTaskDay(e.target.value)}
                />
                <Field
                  name="taskStatus"
                  label="Task status"
                  options={[
                    { id: "all", name: "All tasks" },
                    { id: "open", name: "Open" },
                    { id: "done", name: "Completed" },
                  ]}
                  value={taskStatus}
                  onChange={(e) => setTaskStatus(e.target.value)}
                />
              </div>
              <Panel title="Daily checklist">
                <p className="iv-muted">
                  Create tasks for a specific day and location. Completion is
                  timestamped and attributed to your account. Recurring
                  templates, team assignment and approval rules will follow the
                  agreed SOP.
                </p>
                <Table
                  heads={["Day", "Location", "Task", "Status", "Action"]}
                  rows={visibleTasks.map((t) => [
                    String(t.day).slice(0, 10),
                    locationName(t.location_id),
                    t.title,
                    t.completed_at
                      ? `Completed ${date(t.completed_at)}`
                      : "Open",
                    t.completed_at ? (
                      "—"
                    ) : (
                      <form onSubmit={submit("complete_task")}>
                        <input type="hidden" name="taskId" value={t.id} />
                        {button("Complete")}
                      </form>
                    ),
                  ])}
                  empty="No tasks match this selection. Add the next opening, closing or handover task below, or change the date filter."
                />
              </Panel>
              <Panel title="Add a daily task">
                <form className="iv-form" onSubmit={submit("task")}>
                  <Field name="title" label="Task" maxLength={300} />
                  <Field
                    name="locationId"
                    label="Location (optional)"
                    options={locations}
                    required={false}
                  />
                  <Field
                    name="day"
                    label="Business day"
                    type="date"
                    defaultValue={today()}
                  />
                  {button("Add task")}
                </form>
              </Panel>
            </>
          )}
          {section.path === "assistant" && (
            <AssistantContent data={data} Panel={Panel} example={example} />
          )}
        </>
      )}
    </div>
  );
}
