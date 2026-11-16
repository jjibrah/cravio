import { routes as inventory } from './inventory.js';
import { routes as me } from './me.js';
import { routes as owner } from './owner.js';
import { routes as stock } from './stock.js';
import { routes as restaurant } from './restaurant.js';
import { routes as menuMerch } from './menu-merch.js';
import { routes as adminUsers } from './admin-users.js';
import { routes as publicMenu } from './public-menu.js';
import { routes as publicGuest } from './public-guest.js';
import { routes as operations } from './operations.js';
import { routes as support } from './support.js';
import { routes as adminPlatform } from './admin-platform.js';
import { routes as adminBusiness } from './admin-business.js';
import { routes as settings } from './settings.js';

export const routes = [...inventory, ...me, ...owner, ...stock, ...settings, ...menuMerch, ...restaurant, ...adminBusiness, ...adminPlatform, ...adminUsers, ...publicMenu, ...publicGuest, ...operations, ...support];
