import { useOutletContext } from 'react-router-dom';
import PageFrame from '../components/dashboard/PageFrame';
import ProductsPage from './ProductsPage';
import OverviewPage from './owner/OverviewPage';
import UsersPage from './admin/UsersPage';
import OrdersPage from './owner/OrdersPage';
import TablesPage from './owner/TablesPage';
import MenuConfigPage from './owner/MenuConfigPage';

export default function DashboardPlaceholder({ section }) {
  const { account } = useOutletContext() || {};
  if (section.kind === 'products' && account?.role === 'owner') return <ProductsPage section={section} />;
  if (section.kind === 'users') return <UsersPage section={section} />;
  if (account?.role === 'owner') {
    if (section.kind === 'overview') return <OverviewPage section={section} />;
    if (section.path === 'orders') return <OrdersPage section={section} />;
    if (section.path === 'tables') return <TablesPage section={section} />;
    if (section.path === 'menu') return <MenuConfigPage section={section} />;
  }
  return <PageFrame section={section} />;
}
