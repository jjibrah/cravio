import { routes as me } from './me.js';
import { routes as restaurant } from './restaurant.js';
import { routes as menuMerch } from './menu-merch.js';
import { routes as adminUsers } from './admin-users.js';
import { routes as publicMenu } from './public-menu.js';
import { routes as publicGuest } from './public-guest.js';
import { routes as operations } from './operations.js';

export const routes = [...me, ...menuMerch, ...restaurant, ...adminUsers, ...publicMenu, ...publicGuest, ...operations];
