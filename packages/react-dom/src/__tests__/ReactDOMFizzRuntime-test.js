/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment ./scripts/jest/ReactDOMServerIntegrationEnvironment
 */

'use strict';

import {insertNodesAndExecuteScripts} from '../test-utils/FizzTestUtils';

let React;
let ReactDOMClient;
let ReactDOMServer;
let ReactDOMStatic;
let Stream;
let JSDOM;
let serverAct;
let clientAct;

describe('ReactDOMFizzRuntime', () => {
  beforeEach(() => {
    jest.resetModules();
    JSDOM = require('jsdom').JSDOM;

    const dom = new JSDOM(
      '<!DOCTYPE html><html><head></head><body></body></html>',
      {
        runScripts: 'dangerously',
      },
    );
    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;
    global.Node = dom.window.Node;
    window.requestAnimationFrame = callback => setTimeout(callback);
    window.matchMedia = () => ({matches: true});

    React = require('react');
    ReactDOMClient = require('react-dom/client');
    ReactDOMServer = require('react-dom/server');
    ReactDOMStatic = require('react-dom/static');
    Stream = require('stream');
    ({serverAct, act: clientAct} = require('internal-test-utils'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    window.close();
  });

  function render(children, options) {
    let output = '';
    const writable = new Stream.PassThrough();
    writable.setEncoding('utf8');
    writable.on('data', chunk => {
      output += chunk;
    });
    const request = ReactDOMServer.renderToPipeableStream(children, options);
    request.pipe(writable);
    return {
      abort: request.abort,
      async read() {
        await new Promise(resolve => setImmediate(resolve));
        await serverAct(async () => {});
        const html = output;
        output = '';
        return html;
      },
    };
  }

  async function insertHTML(html, target, nonce = null) {
    const source = document.createElement('div');
    source.innerHTML = html;
    await insertNodesAndExecuteScripts(source, target, nonce);
    jest.runAllTimers();
  }

  async function installPage(options) {
    const nonce =
      typeof options?.nonce === 'string'
        ? options.nonce
        : options?.nonce?.script;
    const page = render(
      <html>
        <head />
        <body>
          <script nonce={nonce}>
            {ReactDOMServer.getFizzRuntimeScriptContent()}
          </script>
          <section id="first-root" />
          <section id="second-root" />
        </body>
      </html>,
      {identifierPrefix: 'page-', externalRuntime: true, ...options},
    );
    const html = await page.read();
    const parsed = new JSDOM(html);
    await insertNodesAndExecuteScripts(
      parsed.window.document.head,
      document.head,
      nonce,
    );
    await insertNodesAndExecuteScripts(
      parsed.window.document.body,
      document.body,
      nonce,
    );
    parsed.window.close();
    jest.runAllTimers();
    return html;
  }

  it.each(['a-nonce', {script: 'a-nonce', style: 'style-nonce'}])(
    'installs the explicitly provided runtime before bootstrap scripts, respecting nonce %p',
    async nonce => {
      const listener = jest.spyOn(window, 'addEventListener');
      await installPage({
        nonce,
        bootstrapScriptContent:
          'window.runtimeReady = typeof $RS === "function" && typeof $RC === "function";',
      });
      expect(window.runtimeReady).toBe(true);
      expect(typeof window.$RS).toBe('function');
      expect(typeof window.$RC).toBe('function');
      expect(typeof window.$RR).toBe('function');
      expect(typeof window.$RX).toBe('function');
      expect(window.$RM.size).toBe(0);
      expect(
        listener.mock.calls.filter(([type]) => type === 'submit'),
      ).toHaveLength(1);
      const scripts = Array.from(document.querySelectorAll('script'));
      expect(scripts).toHaveLength(2);
      expect(scripts.every(script => script.nonce === 'a-nonce')).toBe(true);
    },
  );

  it('reuses an explicitly provided runtime when a fragment completes a boundary', async () => {
    let resolve;
    const promise = new Promise(r => (resolve = r));
    function Content() {
      React.use(promise);
      return <p>Complete</p>;
    }
    const stream = render(
      <>
        <script>{ReactDOMServer.getFizzRuntimeScriptContent()}</script>
        <div>
          <React.Suspense fallback={<p>Loading</p>}>
            <Content />
          </React.Suspense>
        </div>
      </>,
      {externalRuntime: true},
    );
    await insertHTML(await stream.read(), document.body);
    const runtime = window.$RC;
    expect(document.querySelector('p').textContent).toBe('Loading');
    resolve();
    const completion = await stream.read();
    expect(completion).toContain('$RC(');
    expect(completion).not.toContain('$RC=');
    await insertHTML(completion, document.body);
    expect(document.querySelector('p').textContent).toBe('Complete');
    expect(window.$RC).toBe(runtime);
  });

  // @gate enableViewTransition
  it('includes the ViewTransition runtime for independently streamed regions', async () => {
    await installPage();
    window.CSS = {escape: text => text};
    Object.defineProperty(document, 'fonts', {
      value: {ready: Promise.resolve()},
    });
    jest
      .spyOn(window.Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        left: 0,
        top: 0,
        width: 100,
        height: 20,
        right: 100,
        bottom: 20,
      });
    document.startViewTransition = jest.fn(options => {
      options.update();
      return {ready: Promise.resolve(), finished: Promise.resolve()};
    });
    let resolve;
    const promise = new Promise(r => (resolve = r));
    function Content() {
      React.use(promise);
      return <p>Ready</p>;
    }
    const region = render(
      <article>
        <React.Suspense
          fallback={
            <React.ViewTransition>
              <p>Loading</p>
            </React.ViewTransition>
          }>
          <React.ViewTransition>
            <Content />
          </React.ViewTransition>
        </React.Suspense>
      </article>,
      {externalRuntime: true},
    );
    const root = document.getElementById('first-root');
    await insertHTML(await region.read(), root);
    resolve();
    await insertHTML(await region.read(), root);
    await serverAct(async () => {});
    expect(root.querySelector('p').textContent).toBe('Ready');
    expect(document.startViewTransition).toHaveBeenCalledTimes(1);
  });

  it('shares the page runtime with lazy regions that hydrate independently', async () => {
    const listener = jest.spyOn(window, 'addEventListener');
    await installPage();
    const completeBoundary = window.$RC;
    const boundaryQueue = window.$RB;
    const styles = window.$RM;

    let resolve;
    const LazyContent = React.lazy(() => new Promise(r => (resolve = r)));
    function Region({name}) {
      const id = React.useId();
      const [count, setCount] = React.useState(0);
      return (
        <div>
          <label htmlFor={id}>{name}</label>
          <input id={id} />
          <button onClick={() => setCount(count + 1)}>{count}</button>
          <form action={() => {}}>
            <button>Submit</button>
          </form>
          <React.Suspense fallback={<p>Loading</p>}>
            <LazyContent name={name} />
          </React.Suspense>
        </div>
      );
    }

    const first = render(<Region name="First" />, {
      identifierPrefix: 'first-',
      externalRuntime: true,
    });
    const second = render(<Region name="Second" />, {
      identifierPrefix: 'second-',
      externalRuntime: true,
    });
    const firstRoot = document.getElementById('first-root');
    const secondRoot = document.getElementById('second-root');
    const firstShell = await first.read();
    const secondShell = await second.read();
    expect(firstShell).not.toMatch(/\$R[CXS]=|addEventListener\("submit"/);
    expect(secondShell).not.toMatch(/\$R[CXS]=|addEventListener\("submit"/);
    await insertHTML(firstShell, firstRoot);
    await insertHTML(secondShell, secondRoot);
    expect(firstRoot.querySelector('p').textContent).toBe('Loading');

    resolve({default: ({name}) => <p>{name} content</p>});
    const firstCompletion = await first.read();
    const secondCompletion = await second.read();
    expect(firstCompletion).toContain('$RC(');
    expect(secondCompletion).toContain('$RC(');
    expect(firstCompletion).not.toMatch(/\$R[CXS]=/);
    expect(secondCompletion).not.toMatch(/\$R[CXS]=/);
    await insertHTML(firstCompletion, firstRoot);
    await insertHTML(secondCompletion, secondRoot);
    expect(firstRoot.querySelector('p').textContent).toBe('First content');
    expect(secondRoot.querySelector('p').textContent).toBe('Second content');
    expect(window.$RC).toBe(completeBoundary);
    expect(window.$RB).toBe(boundaryQueue);
    expect(window.$RM).toBe(styles);
    expect(
      listener.mock.calls.filter(([type]) => type === 'submit'),
    ).toHaveLength(1);

    const firstID = firstRoot.querySelector('input').id;
    const secondID = secondRoot.querySelector('input').id;
    expect(firstID).toContain('first-');
    expect(secondID).toContain('second-');
    expect(firstID).not.toBe(secondID);
    const form = secondRoot.querySelector('form');
    const submit = new window.Event('submit', {
      bubbles: true,
      cancelable: true,
    });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(document.$$reactFormReplay).toHaveLength(3);
    expect(document.$$reactFormReplay[0]).toBe(form);

    await clientAct(async () => {
      ReactDOMClient.hydrateRoot(firstRoot, <Region name="First" />, {
        identifierPrefix: 'first-',
      });
      ReactDOMClient.hydrateRoot(secondRoot, <Region name="Second" />, {
        identifierPrefix: 'second-',
      });
    });
    expect(firstRoot.querySelector('input').id).toBe(firstID);
    expect(secondRoot.querySelector('input').id).toBe(secondID);
    await clientAct(async () => {
      firstRoot
        .querySelector('button')
        .dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    });
    expect(firstRoot.querySelector('button').textContent).toBe('1');
    expect(secondRoot.querySelector('button').textContent).toBe('0');
  });

  it('completes partial segments without reinitializing the shared runtime', async () => {
    await installPage();
    let resolveFirst;
    let resolveSecond;
    const first = new Promise(r => (resolveFirst = r));
    const second = new Promise(r => (resolveSecond = r));
    function Text({promise}) {
      return React.use(promise);
    }
    const region = render(
      <article>
        <React.Suspense fallback="Loading">
          <div>
            <Text promise={first} />
            <Text promise={second} />
          </div>
        </React.Suspense>
      </article>,
      {identifierPrefix: 'region-', externalRuntime: true},
    );
    const root = document.getElementById('first-root');
    await insertHTML(await region.read(), root);
    resolveFirst('First');
    const partial = await region.read();
    expect(partial).toContain('$RS(');
    expect(partial).not.toContain('$RS=');
    await insertHTML(partial, root);
    resolveSecond('Second');
    await insertHTML(await region.read(), root);
    expect(root.querySelector('div').textContent).toBe('FirstSecond');
  });

  it('reuses the shared style runtime when a region reveals a stylesheet', async () => {
    await installPage();
    let resolve;
    const promise = new Promise(r => (resolve = r));
    function Content() {
      React.use(promise);
      return (
        <>
          <link rel="stylesheet" href="region.css" precedence="default" />
          <p>Styled</p>
        </>
      );
    }
    const region = render(
      <article>
        <React.Suspense fallback={<p>Loading</p>}>
          <Content />
        </React.Suspense>
      </article>,
      {identifierPrefix: 'styled-', externalRuntime: true},
    );
    const root = document.getElementById('first-root');
    await insertHTML(await region.read(), root);
    resolve();
    const completion = await region.read();
    expect(completion).toContain('$RR(');
    expect(completion).not.toContain('$RM=');
    await insertHTML(completion, root);
    const stylesheet = document.querySelector('link[rel="stylesheet"]');
    stylesheet.dispatchEvent(new window.Event('load'));
    await serverAct(async () => {});
    jest.runAllTimers();
    expect(root.querySelector('p').textContent).toBe('Styled');
    expect(document.head.contains(stylesheet)).toBe(true);
  });

  it('reuses the shared client-render instruction when a region is aborted', async () => {
    await installPage();
    const promise = new Promise(() => {});
    function Pending() {
      return React.use(promise);
    }
    const onError = jest.fn(() => 'aborted-region');
    const region = render(
      <div>
        <React.Suspense fallback="Loading">
          <Pending />
        </React.Suspense>
      </div>,
      {identifierPrefix: 'aborted-', externalRuntime: true, onError},
    );
    const root = document.getElementById('first-root');
    await insertHTML(await region.read(), root);
    const reason = new Error('Abort this region');
    region.abort(reason);
    const completion = await region.read();
    expect(completion).toContain('$RX(');
    expect(completion).not.toContain('$RX=');
    await insertHTML(completion, root);
    expect(onError.mock.calls[0][0]).toBe(reason);
    expect(root.querySelector('div').firstChild.data).toBe('$!');
  });

  it('writes the explicitly provided runtime exactly once under backpressure', async () => {
    let html = '';
    const writable = new Stream.Writable({
      highWaterMark: 1,
      write(chunk, encoding, callback) {
        html += chunk.toString('utf8');
        setImmediate(callback);
      },
    });
    const finished = new Promise(resolve => writable.on('finish', resolve));
    const request = ReactDOMServer.renderToPipeableStream(
      <>
        <script>{ReactDOMServer.getFizzRuntimeScriptContent()}</script>
        <p>Complete</p>
      </>,
      {externalRuntime: true},
    );
    request.pipe(writable);
    await finished;
    await insertHTML(html, document.body);
    expect(document.querySelector('p').textContent).toBe('Complete');
    expect(document.querySelectorAll('script')).toHaveLength(1);
    expect(typeof window.$RS).toBe('function');
    expect(typeof window.$RR).toBe('function');
  });

  it('preserves the default output when externalRuntime is false', async () => {
    const defaultRender = render(<form action={() => {}} />);
    const inlineRender = render(<form action={() => {}} />, {
      externalRuntime: false,
    });
    const defaultHTML = await defaultRender.read();
    expect(defaultHTML).toContain('addEventListener("submit"');
    expect(await inlineRender.read()).toBe(defaultHTML);
  });

  it('does not install a runtime automatically when externalRuntime is true', async () => {
    const listener = jest.spyOn(window, 'addEventListener');
    const region = render(<form action={() => {}} />, {
      externalRuntime: true,
    });
    const html = await region.read();
    expect(html).not.toContain('<script');
    await insertHTML(html, document.body);
    expect(window.$RC).toBe(undefined);
    expect(
      listener.mock.calls.filter(([type]) => type === 'submit'),
    ).toHaveLength(0);
  });

  // @gate enableFizzExternalRuntime
  it('preserves the template instruction transport with externalRuntime', async () => {
    const promise = new Promise(() => {});
    function Pending() {
      return React.use(promise);
    }
    const options = {unstable_externalRuntimeSrc: 'runtime.js'};
    const children = (
      <div>
        <React.Suspense fallback="Loading">
          <Pending />
        </React.Suspense>
      </div>
    );
    const defaultRender = render(children, {...options, onError() {}});
    const externalRender = render(children, {
      ...options,
      externalRuntime: true,
      onError() {},
    });
    const defaultShell = await defaultRender.read();
    expect(defaultShell).toContain('src="runtime.js"');
    expect(await externalRender.read()).toBe(defaultShell);
    const reason = new Error('Abort both renders');
    defaultRender.abort(reason);
    externalRender.abort(reason);
    const completion = await defaultRender.read();
    expect(completion).toContain('data-rxi');
    expect(await externalRender.read()).toBe(completion);
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'preserves externalRuntime=%s when resuming a prerender (postponed shell: %s)',
    async (externalRuntime, postponeShell) => {
      if (externalRuntime) {
        await installPage();
      }
      let pending = true;
      const promise = new Promise(() => {});
      function Content() {
        if (pending) {
          return React.use(promise);
        }
        return (
          <form action={() => {}}>
            <p>Resumed</p>
          </form>
        );
      }
      function App() {
        return postponeShell ? (
          <Content />
        ) : (
          <div>
            <React.Suspense fallback="Loading">
              <Content />
            </React.Suspense>
          </div>
        );
      }
      const controller = new AbortController();
      let prerender;
      await serverAct(async () => {
        prerender = ReactDOMStatic.prerenderToNodeStream(<App />, {
          identifierPrefix: 'resumed-',
          externalRuntime,
          signal: controller.signal,
          onError() {},
        });
      });
      controller.abort('postpone');
      const result = await prerender;
      let prelude = '';
      await new Promise((resolve, reject) => {
        result.prelude.on('data', chunk => {
          prelude += chunk.toString('utf8');
        });
        result.prelude.on('error', reject);
        result.prelude.on('end', resolve);
      });
      if (postponeShell) {
        expect(prelude).toBe('');
      } else {
        expect(prelude).toContain('Loading');
      }
      const target = document.createElement('section');
      document.body.appendChild(target);
      await insertHTML(prelude, target);
      const runtime = window.$RC;
      const postponed = JSON.parse(JSON.stringify(result.postponed));
      expect(postponed.resumableState.externalRuntime).toBe(externalRuntime);
      pending = false;
      let completion = '';
      const writable = new Stream.PassThrough();
      writable.setEncoding('utf8');
      writable.on('data', chunk => {
        completion += chunk;
      });
      const request = ReactDOMServer.resumeToPipeableStream(<App />, postponed);
      request.pipe(writable);
      await serverAct(async () => {});
      await insertHTML(completion, target);
      expect(target.querySelector('p').textContent).toBe('Resumed');
      if (externalRuntime) {
        expect(window.$RC).toBe(runtime);
        expect(completion).not.toContain('$RC=');
        expect(completion).not.toContain('addEventListener("submit"');
      } else if (!postponeShell) {
        expect(typeof window.$RC).toBe('function');
      } else {
        expect(window.$RC).toBe(undefined);
      }
    },
  );
});
