# CRAVIO

Minimal sign-in, password recovery, and reusable dashboards with three protected roles.

## Tech stack

- Frontend: React.js, Vite, React Router
- Backend: Node.js
- Authentication and database: Supabase

## Run locally

Use Node.js 22.12+ and npm. From the project root:

```sh
npm install
npm run dev
```

Open http://localhost:5173. The backend runs on http://localhost:3002.
`npm run dev` starts and stops both apps together.

### Compare main and dev

The comparison launcher lives on `dev`. It serves the unchanged `main` checkout at
http://localhost:5173 and the `dev` checkout at http://localhost:5174, with backends
on ports 3003 and 3004 respectively. Both retain the existing Cravio design.

From the `dev` checkout:

```sh
npm run compare
```

It expects a sibling `cravio-main-baseline` worktree on `main`, with dependencies
installed and both its `frontend/.env` and `backend/.env` configured. Set
`CRAVIO_MAIN_DIR` to use another main checkout. The current local worktree has
already been prepared. The launcher checks branch names and ports, overrides each
app's backend/proxy ports and stops all four app processes together with Ctrl+C.

By explicit choice, this baseline comparison uses the **same database**. Changes
made through either app affect the same records. The launcher does not migrate or
seed it. Set up isolated development data before implementing inventory migrations
or running mutation tests. Hosted Auth redirects for port 5174 must be allowed
before testing invitation/password recovery links there.

New inventory, management and AI features have not been implemented yet. Review
the [implementation plan](IMPLEMENTATION_PLAN.md) and take the
[Fayaz questionnaire](question.md) to the discovery meeting. Future features stay
on `dev` for review at port 5174; merge/restart main only after approval.

The visual system ("Service-grade Swiss": Geist, warm paper, a dark navigation
rail, and one ember accent) is documented in [DESIGN.md](DESIGN.md), including
tokens, type scale, and the research behind it.

There is no public landing page: `/` opens the sign-in page (signed-in users go straight to their dashboard).

To run them in separate terminals:

```sh
npm run dev:frontend
npm run dev:backend
```

The frontend development proxy reads the backend port from `backend/.env`.
Restart the frontend after changing that port.

## Accounts and roles

| Role | Email | Password | Landing page |
| --- | --- | --- | --- |
| Admin | `ibrabdi109@gmail.com` | Set manually in Supabase Auth | `/admin` |
| Owner | `owner@gmail.com` | `12344321` | `/owner` |
| Waiter | `waiter@gmail.com` | `12344321` | `/waiter` |

Admin and owner dashboards show the user's name and email in the bottom
sidebar profile control, which opens Settings and logout actions. The waiter
uses a mobile-first layout, with account details and logout in a profile sheet.
An authenticated user visiting another role's page is sent to their own page.

## Shared dashboard components

- `frontend/src/components/Brand.jsx`: the Cravio wordmark and its ember square mark.
- `frontend/src/components/dashboard/TopNav.jsx`: breadcrumb, refresh, and notifications.
- `frontend/src/components/dashboard/Sidebar.jsx`: dark rail with role-specific navigation grouped by job (the `group` field in `config/dashboards.js`) and a mobile drawer.
- `frontend/src/components/dashboard/ProfileMenu.jsx`: bottom profile control with Settings and logout.
- `frontend/src/components/dashboard/PlaceSummary.jsx`: compact place name, status, and location in the owner sidebar.
- `frontend/src/components/dashboard/DashboardLayout.jsx`: shared, protected dashboard frame.
- `frontend/src/components/notifications/NotificationProvider.jsx`: compact pill notifications.
- `frontend/src/components/notifications/NotificationCenter.jsx`: navbar bell, unread count, and recent notifications.
- `frontend/src/components/loading/LoadingScreen.jsx`: centered Cravio wordmark with a small animated loading indicator.
- `frontend/src/components/RefreshButton.jsx`: compact shared refresh control for all three dashboard headers.
- `frontend/src/components/Sheet.jsx`: reusable native bottom sheet with focus management and Escape/backdrop dismissal.
- `frontend/src/components/waiter/WaiterLayout.jsx`: mobile waiter header and bottom navigation.

Navigation and placeholder descriptions are defined in
`frontend/src/config/dashboards.js`. Each section has a URL that supports
refreshing and direct navigation.

Admin pages: Overview, Restaurants, Performance, Money, Leads & requests,
Complaints, and Settings. Owner pages: Overview, Orders, Tables, Products, Menu Configuration, Insights,
Settings, and Contact Cravio. These pages contain placeholders only.

The owner sidebar shows a place summary beneath the Cravio wordmark, using
`Name`, `Status`, and `Location` placeholders until real values are available
from `account.place`.

The owner's compact **Guest Menu** link sits above the footer divider, just
above Contact Cravio. It opens the public `/guest-menu`
placeholder in a new tab. It is not connected to restaurant menu data yet.

Successful password sign-in displays a dismissible **Login successful** pill.
Notifications close automatically after five seconds, pause while hovered or
focused, and do not repeat when restoring an existing session. Reuse them from
any child of `NotificationProvider`:

```jsx
const { notify } = useNotifications();
notify('Changes saved');
notify('Could not save changes', { type: 'error', duration: 7000 });
```

Login, password recovery, and password validation errors use dismissible error
pills. Errors clear when retrying or leaving their form. Persistent account
errors use the same pill treatment inline.

The navbar bell opens recent notifications with an unread badge, **Mark all
read**, and **Clear all**. This history contains actual notifications raised
in the current tab, is capped at 20 entries, and clears when the signed-in
account changes or the page reloads. It is not a database-backed inbox yet.

The mobile sidebar supports Escape, focus wrapping, closing after navigation,
and restoring focus to the navigation button. Links have no underlines.

Each dashboard header includes a subtle refresh icon. Refresh revalidates the
account and reloads the active page in place, preserves the current route,
prevents duplicate requests, and keeps the header visible. Failed requests
show an error pill; an expired or unauthorized session clears the protected
view. The icon's loading animation respects reduced-motion preferences.

## Waiter mobile interface

The waiter opens on **Tables** at `/waiter`, with **Services** at
`/waiter/services` and **Menu** at `/waiter/menu`. These three pages contain
placeholders. Bottom navigation stays visible while the main content scrolls.

The top bar shows the restaurant name, notifications, and a profile button.
Notifications and profile actions open in bottom sheets. The profile contains
the signed-in waiter's name, email, role, and logout action.

Restaurant records are not connected yet, so the header defaults to
`Your restaurant`. Optionally set `VITE_RESTAURANT_NAME` in `frontend/.env`
and restart Vite to customize this temporary name.

The mobile layout includes touch targets, dynamic viewport sizing, and safe-area
padding. PWA installation and offline behavior are not implemented in this step.
Loading screens throughout the app use the Cravio wordmark and three animated
dots, with a reduced-motion fallback.

Create the admin manually in **Supabase Dashboard → Authentication → Users**,
using the reserved email and a confirmed email address. Its protected profile
is assigned the `admin` role automatically, with `Super Admin` as the default
name. You can supply a `name` in user metadata when creating it.

There is no public sign-up page. Accounts without an assigned role see a
waiting-for-setup page. Editing user metadata cannot grant a role. Role records
are protected by database permissions and Row Level Security; users can read
only their own profile and cannot edit roles. There can be only one admin.

## Environment files

Both local `.env` files are ignored by Git. Examples contain no credentials.
For a fresh checkout, copy each `.env.example` to `.env` in the same directory.

`frontend/.env`:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-or-legacy-anon-key
```

The frontend key accepts the backend's legacy `SUPABASE_ANON_KEY`.
For separately hosted APIs, optionally set `VITE_API_URL` to the API origin.
Otherwise requests use `/api` on the frontend's origin.

`backend/.env`:

```dotenv
PORT=3002
FRONTEND_URL=http://localhost:5173
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-role-key
SUPABASE_DB_URL=your-postgres-connection-string
SUPER_ADMIN_EMAIL=ibrabdi109@gmail.com
```

The backend also accepts `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`
as aliases for the newer key types. Database and service keys are used only
by the backend's administrative scripts. The runtime `/api/me` endpoint
validates the user's token with Supabase and queries with that user's RLS
permissions, using the public key.

## Password recovery

- `/login`: email and password sign-in.
- `/forgot-password`: sends a reset link through Supabase Auth.
- `/reset-password`: accepts a valid recovery session, confirms the new
  password, updates it, and logs the user out.

In **Supabase Authentication → URL Configuration**, allow
`http://localhost:5173/reset-password`. Add the corresponding production URL
when deploying. The existing project's localhost redirect was verified.

Email delivery uses the project's Supabase mail configuration. Configure
custom SMTP for delivery to arbitrary platform users; the default Supabase
sender has recipient and rate restrictions. See
[Supabase password authentication](https://supabase.com/docs/guides/auth/passwords)
and [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

## Onboarding and user management

- **Owner onboarding** (`/onboarding`): a one-question-per-screen setup flow.
  - It covers the basics, tables, staff, menu, look, and "You're live!".
  - A live phone preview fills in as the owner answers, and progress is saved on the server after every step.
  - Owners whose restaurant is still in `onboarding` are sent there automatically.
  - Skipped steps reappear as a "Finish setting up" checklist on the owner overview.
  - The QR pack is at `/onboarding/qr`.
- **Invitations:** invited users land on `/welcome` to set a password.
- **Admin users** (`/admin/users`):
  - Invite admins, owners (with a restaurant name) or waiters (assigned to a restaurant).
  - Change roles, and suspend or reactivate access.
  - The reserved `SUPER_ADMIN_EMAIL` account is the protected primary admin.
- **Server-side code:**
  - Restaurant data lives in Supabase tables with row-level security (`backend/db/migrations/002_restaurants.sql`).
  - Uploads go to the public `restaurant-media` bucket.
  - The backend uses the service key only for invitations and admin actions, and only after checking the caller's role.

Before inviting real people:

1. In **Supabase → Authentication → URL Configuration**, allow `<frontend origin>/welcome`.
2. Set `FRONTEND_URL` in `backend/.env` to the frontend origin.
3. Configure **custom SMTP**. Supabase's default sender only delivers to your project team and rejects addresses such as `example.com`.
4. To test real invites, run the suite with `CRAVIO_TEST_INVITE_DOMAIN=<your domain>`. Without it, the invite-sending test is skipped.

## Owner settings

`/owner/settings` is where an owner changes anything after setup. Each section has its own URL
(`?tab=restaurant|hours|floor|team|account`), so links and refresh work:

- **Restaurant:** name, kind, phone, area and street (saved together), plus the logo and cover photo (saved as soon as they upload).
- **Opening hours:** every day, weekdays or custom per day.
- **Tables & QR codes:** table count, sections, the guest-menu link (copy or open) and the printable QR pack.
- **Team:** invite waiters and managers (sent immediately once the restaurant is live), resend or remove
  undelivered invites, change a member's role, or remove their access. Only the owner changes the team; managers can see it.
- **Your account:** your name, password, and signing out of other devices. Admins see only this section.

Every form shows a save bar only when something has changed. Successes and failures use the notification pills.

The **Finish setting up** card on the owner Overview disappears as soon as all seven steps are done.

## Migrations

```sh
npm run db:migrate            # applies backend/db/migrations/*.sql once each, in order
npm run db:migrate -- --dry-run
npm run db:seed               # demo owner (live "Demo Restaurant"), waiter, and onboarding@gmail.com
```

`onboarding@gmail.com` (password `12344321`) owns "Mama Oliech's", which is in onboarding.

Migration `003_operations.sql` adds live operations: guest carts, orders, payments, guest requests, menu scans and
dish video. After applying it, `npm run db:seed` also gives the Demo Restaurant 12 tables, a Kenyan menu and 14 days
of activity, including live orders and open guest requests. It replaces that activity on every run. The API contract
for these features is in [docs/API.md](docs/API.md).
The onboarding test resets it on every run.

Migration `006_support_requests.sql` adds `support_requests`: what owners send from **Contact Cravio**
(`/owner/contact-cravio`), and what the Cravio team works through in **Leads & requests** and **Complaints**
under `/admin`. Owners and managers can create and read their own restaurant's requests (RLS); only the admin
API (service client) can change status or reply. Until it is applied, Contact Cravio shows only the call,
WhatsApp and email options. The support phone, WhatsApp number and email are placeholders in `CRAVIO_SUPPORT`
at the top of `frontend/src/pages/owner/ContactPage.jsx`. The admin Overview, Restaurants, Performance and
Money pages read live data (see [docs/API.md §17](docs/API.md#17-contact-cravio-and-the-cravio-admin-platform)).

## Database setup

The current project has already been reset and seeded. These commands are for
future explicit setup; they never run on application startup:

```sh
npm run db:setup
npm run db:seed
```

`db:setup` installs `backend/db/schema.sql` and reserves `SUPER_ADMIN_EMAIL`.
`db:seed` creates or updates just the owner and waiter demo accounts and resets
their passwords to `12344321`.

The destructive reset is separate and explicit:

```sh
npm run db:setup --workspace backend -- --reset --confirm-reset
npm run db:seed
```

It removes the application schemas and all Auth users, including an existing
admin. Create the admin again afterward. Supabase-managed schemas and
extensions remain installed. Storage must be emptied through its API before
resetting a project that contains stored objects.

Administrative database connections use TLS with certificate verification.
The public Supabase root certificate is stored in `backend/db/supabase-ca.crt`.

## Build and production

```sh
npm run build
npm run start:backend
```

The static frontend build is in `frontend/dist/`. Host it with SPA fallbacks
for React Router paths, and forward `/api` to the Node backend. For separate
origins, set frontend `VITE_API_URL` and backend `FRONTEND_URL` before building
and starting the apps.

## Verification

```sh
npx playwright install chromium
npm test
```

Tests use the configured Supabase project and seeded accounts. They check
login, logout, role redirects, RLS, protected role assignment, password recovery,
API token validation, all dashboard routes, profile actions, login notifications,
the guest-menu tab, and mobile drawer keyboard behavior. The recovery test temporarily changes
the waiter password and restores `12344321` in a `finally` block. It generates
recovery links through the admin API without sending emails; email request UI
states are tested with an intercepted response.
