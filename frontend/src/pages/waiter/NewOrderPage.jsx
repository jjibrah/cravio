import { useSearchParams } from 'react-router-dom';
import OrderComposer from '../../components/waiter/OrderComposer';
import { PageHeader, TablePicker } from '../../components/waiter/WaiterBits';

const tableParam = (value) => (value === 'takeaway' ? 'takeaway' : /^\d{1,3}$/.test(value || '') ? Number(value) : null);

/** New order: pick the table (if not given), then scan the guest's code and confirm it with them, or enter it by hand. */
export default function NewOrderPage() {
  const [params, setParams] = useSearchParams();
  const table = tableParam(params.get('table'));
  const choose = (value) => setParams(value == null ? {} : { table: String(value) });

  if (table == null) {
    return <>
      <PageHeader title="New order" subtitle="Which table is it for?" />
      <TablePicker onChoose={choose} />
    </>;
  }

  return <>
    <PageHeader title="New order" subtitle="Scan the guest’s code and check the order with them." />
    <OrderComposer key={String(table)} table={table} onChangeTable={() => choose(null)} />
  </>;
}
