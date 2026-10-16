import { describe, expect, it } from 'vitest';
import { ROUTES, ROUTE_HASH, routeFromHash, routeHash, routeShortcut } from './routes';
import { shortcutAction } from './shortcuts';

describe('page routes', () => {
  it('order the menu Dashboard, Receiver, then the other pages', () => {
    expect(ROUTES.map((route) => route.id)).toEqual(['overview', 'receiver', 'system-health', 'doa-diagnostics', 'configuration', 'message-monitor', 'simulation']);
  });

  it('write #/dashboard for the Dashboard and the route id for the others', () => {
    expect(routeHash('overview')).toBe('#/dashboard');
    expect(routeHash('receiver')).toBe('#/receiver');
    expect(routeHash('message-monitor')).toBe('#/message-monitor');
    for (const route of ROUTES) expect(routeFromHash(routeHash(route.id))).toBe(route.id);
  });

  it('keep #/overview and the older names working', () => {
    expect(routeFromHash('#/dashboard')).toBe('overview');
    expect(routeFromHash('#/overview')).toBe('overview');
    expect(routeFromHash('#/live-doa')).toBe('overview');
    expect(routeFromHash('#/map')).toBe('overview');
    expect(routeFromHash('#/health')).toBe('system-health');
    expect(routeFromHash('#/diagnostics')).toBe('doa-diagnostics');
    expect(routeFromHash('#/settings')).toBe('configuration');
    expect(routeFromHash('#/mqtt')).toBe('message-monitor');
    expect(routeFromHash('#/receiver?mock=1')).toBe('receiver');
    expect(routeFromHash('#receiver')).toBe('receiver');
  });

  it('open the Dashboard for an empty or unknown hash, including object keys', () => {
    for (const hash of ['', '#', '#/', '#/nope', '#/constructor', '#/__proto__', '#/toString']) expect(routeFromHash(hash), hash).toBe('overview');
  });

  it('number each page by its place in the menu', () => {
    expect(ROUTES.map((route) => routeShortcut(route.id))).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(Object.keys(ROUTE_HASH).sort()).toEqual(ROUTES.map((route) => route.id).sort());
  });

  it('send key 2 to the Receiver and key 7 to Simulation', () => {
    const press = (key: string) => shortcutAction({ key, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, target: null }, ROUTES.length);
    const route = (key: string) => {
      const action = press(key);
      return action?.type === 'route' ? ROUTES[action.index].id : null;
    };
    expect(route('1')).toBe('overview');
    expect(route('2')).toBe('receiver');
    expect(route('3')).toBe('system-health');
    expect(route('7')).toBe('simulation');
    expect(route('8')).toBeNull();
  });
});
