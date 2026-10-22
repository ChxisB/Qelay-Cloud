import {
  CardHeader,
  createElement,
  describe,
  expect,
  Field,
  Input,
  installTestHooks,
  MemoryRouter,
  NotFound,
  render,
  settle,
  Sidebar,
  test,
  titleFor,
  useDocumentTitle,
} from './frontend-a11y-fixes.helpers';

installTestHooks();

describe('form and heading semantics', () => {
  test('a compound Field label targets the actual input', () => {
    const { host, unmount } = render(
      createElement(
        Field,
        { label: 'Token', htmlFor: 'token-input' },
        createElement('div', {}, createElement(Input, { id: 'token-input' }))
      )
    );
    const label = host.querySelector('label');
    expect(label?.htmlFor).toBe('token-input');
    expect(label?.control).toBe(host.querySelector('#token-input'));
    unmount();
  });

  test('CardHeader starts at h2 and supports a nested heading level', () => {
    const { host, unmount } = render(
      createElement(
        'div',
        {},
        createElement(CardHeader, { title: 'Top card' }),
        createElement(CardHeader, { title: 'Nested card', headingLevel: 4 })
      )
    );
    expect(host.querySelector('h2')?.textContent).toBe('Top card');
    expect(host.querySelector('h4')?.textContent).toBe('Nested card');
    unmount();
  });

  test('the 404 page has one h1, and the decorative 404 is hidden from assistive tech', () => {
    const { host, unmount } = render(createElement(MemoryRouter, {}, createElement(NotFound)));
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe('That page does not exist');
    expect(host.querySelector('[aria-hidden="true"]')?.textContent).toBe('404');
    unmount();
  });
});

describe('route titles and navigation semantics', () => {
  test('a connection page and its tabs are titled as the Event gateway', () => {
    for (const path of [
      '/events-gateway/connections/hook-1',
      '/events-gateway/connections/hook-1/metrics',
      '/events-gateway/connections/hook-1/',
    ]) {
      expect(titleFor(path)).toBe('Gateway connection');
    }
    expect(titleFor('/events-gateway/connections')).toBe('Page not found');
  });

  test('queue detail titles are decoded without throwing', () => {
    expect(titleFor('/queues/email%20jobs')).toBe('email jobs · Queue');
    expect(titleFor('/queues/%zz')).toContain('%zz');
  });

  test('route titles tolerate trailing slashes', () => {
    expect(titleFor('/settings/')).toBe('Settings');
    expect(titleFor('/queues/email%20jobs/')).toBe('email jobs · Queue');
  });

  test('Topbar keeps document.title in sync with the route', async () => {
    function TitleProbe() {
      useDocumentTitle(titleFor('/database'));
      return null;
    }
    const { unmount } = render(createElement(TitleProbe));
    await settle(1);
    expect(document.title).toBe('Database · Qelay Cloud');
    unmount();
  });

  test('only the exact sidebar destination is aria-current', async () => {
    const { host, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/jobs/bulk-add'] }, createElement(Sidebar))
    );
    await settle(1);
    // Bulk add is a page of Jobs: Jobs is the one current link, not Jobs and Queues together.
    const current = [...host.querySelectorAll('nav a[aria-current="page"]')];
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['/jobs']);
    unmount();
  });
});
