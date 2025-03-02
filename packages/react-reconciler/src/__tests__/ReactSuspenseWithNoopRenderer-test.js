let React;
let Fragment;
let ReactNoop;
let Scheduler;
let act;
let waitFor;
let waitForAll;
let assertLog;
let waitForPaint;
let Suspense;
let getCacheForType;

let caches;
let seededCache;

describe('ReactSuspenseWithNoopRenderer', () => {
  beforeEach(() => {
    jest.resetModules();

    React = require('react');
    Fragment = React.Fragment;
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    act = require('jest-react').act;
    Suspense = React.Suspense;
    const InternalTestUtils = require('internal-test-utils');
    waitFor = InternalTestUtils.waitFor;
    waitForAll = InternalTestUtils.waitForAll;
    waitForPaint = InternalTestUtils.waitForPaint;
    assertLog = InternalTestUtils.assertLog;

    getCacheForType = React.unstable_getCacheForType;

    caches = [];
    seededCache = null;
  });

  function createTextCache() {
    if (seededCache !== null) {
      // Trick to seed a cache before it exists.
      // TODO: Need a built-in API to seed data before the initial render (i.e.
      // not a refresh because nothing has mounted yet).
      const cache = seededCache;
      seededCache = null;
      return cache;
    }

    const data = new Map();
    const version = caches.length + 1;
    const cache = {
      version,
      data,
      resolve(text) {
        const record = data.get(text);
        if (record === undefined) {
          const newRecord = {
            status: 'resolved',
            value: text,
          };
          data.set(text, newRecord);
        } else if (record.status === 'pending') {
          const thenable = record.value;
          record.status = 'resolved';
          record.value = text;
          thenable.pings.forEach(t => t());
        }
      },
      reject(text, error) {
        const record = data.get(text);
        if (record === undefined) {
          const newRecord = {
            status: 'rejected',
            value: error,
          };
          data.set(text, newRecord);
        } else if (record.status === 'pending') {
          const thenable = record.value;
          record.status = 'rejected';
          record.value = error;
          thenable.pings.forEach(t => t());
        }
      },
    };
    caches.push(cache);
    return cache;
  }

  function readText(text) {
    const textCache = getCacheForType(createTextCache);
    const record = textCache.data.get(text);
    if (record !== undefined) {
      switch (record.status) {
        case 'pending':
          Scheduler.unstable_yieldValue(`Suspend! [${text}]`);
          throw record.value;
        case 'rejected':
          Scheduler.unstable_yieldValue(`Error! [${text}]`);
          throw record.value;
        case 'resolved':
          return textCache.version;
      }
    } else {
      Scheduler.unstable_yieldValue(`Suspend! [${text}]`);

      const thenable = {
        pings: [],
        then(resolve) {
          if (newRecord.status === 'pending') {
            thenable.pings.push(resolve);
          } else {
            Promise.resolve().then(() => resolve(newRecord.value));
          }
        },
      };

      const newRecord = {
        status: 'pending',
        value: thenable,
      };
      textCache.data.set(text, newRecord);

      throw thenable;
    }
  }

  function Text({text}) {
    Scheduler.unstable_yieldValue(text);
    return <span prop={text} />;
  }

  function AsyncText({text, showVersion}) {
    const version = readText(text);
    const fullText = showVersion ? `${text} [v${version}]` : text;
    Scheduler.unstable_yieldValue(fullText);
    return <span prop={fullText} />;
  }

  function seedNextTextCache(text) {
    if (seededCache === null) {
      seededCache = createTextCache();
    }
    seededCache.resolve(text);
  }

  function resolveMostRecentTextCache(text) {
    if (caches.length === 0) {
      throw Error('Cache does not exist.');
    } else {
      // Resolve the most recently created cache. An older cache can by
      // resolved with `caches[index].resolve(text)`.
      caches[caches.length - 1].resolve(text);
    }
  }

  const resolveText = resolveMostRecentTextCache;

  function rejectMostRecentTextCache(text, error) {
    if (caches.length === 0) {
      throw Error('Cache does not exist.');
    } else {
      // Resolve the most recently created cache. An older cache can by
      // resolved with `caches[index].reject(text, error)`.
      caches[caches.length - 1].reject(text, error);
    }
  }

  const rejectText = rejectMostRecentTextCache;

  function advanceTimers(ms) {
    // Note: This advances Jest's virtual time but not React's. Use
    // ReactNoop.expire for that.
    if (typeof ms !== 'number') {
      throw new Error('Must specify ms');
    }
    jest.advanceTimersByTime(ms);
    // Wait until the end of the current tick
    // We cannot use a timer since we're faking them
    return Promise.resolve().then(() => {});
  }

  // Note: This is based on a similar component we use in www. We can delete
  // once the extra div wrapper is no longer necessary.
  function LegacyHiddenDiv({children, mode}) {
    return (
      <div hidden={mode === 'hidden'}>
        <React.unstable_LegacyHidden
          mode={mode === 'hidden' ? 'unstable-defer-without-hiding' : mode}>
          {children}
        </React.unstable_LegacyHidden>
      </div>
    );
  }

  // @gate enableLegacyCache
  it('does not restart rendering for initial render', async () => {
    function Bar(props) {
      Scheduler.unstable_yieldValue('Bar');
      return props.children;
    }

    function Foo() {
      Scheduler.unstable_yieldValue('Foo');
      return (
        <>
          <Suspense fallback={<Text text="Loading..." />}>
            <Bar>
              <AsyncText text="A" ms={100} />
              <Text text="B" />
            </Bar>
          </Suspense>
          <Text text="C" />
          <Text text="D" />
        </>
      );
    }

    React.startTransition(() => {
      ReactNoop.render(<Foo />);
    });
    await waitFor([
      'Foo',
      'Bar',
      // A suspends
      'Suspend! [A]',
      // But we keep rendering the siblings
      'B',
      'Loading...',
      'C',
      // We leave D incomplete.
    ]);
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Flush the promise completely
    await resolveText('A');

    // Even though the promise has resolved, we should now flush
    // and commit the in progress render instead of restarting.
    await waitForPaint(['D']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Loading..." />
        <span prop="C" />
        <span prop="D" />
      </>,
    );

    // Next, we'll flush the complete content.
    await waitForAll(['Bar', 'A', 'B']);

    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="B" />
        <span prop="C" />
        <span prop="D" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('suspends rendering and continues later', async () => {
    function Bar(props) {
      Scheduler.unstable_yieldValue('Bar');
      return props.children;
    }

    function Foo({renderBar}) {
      Scheduler.unstable_yieldValue('Foo');
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          {renderBar ? (
            <Bar>
              <AsyncText text="A" />
              <Text text="B" />
            </Bar>
          ) : null}
        </Suspense>
      );
    }

    // Render empty shell.
    ReactNoop.render(<Foo />);
    await waitForAll(['Foo']);

    // The update will suspend.
    React.startTransition(() => {
      ReactNoop.render(<Foo renderBar={true} />);
    });
    await waitForAll([
      'Foo',
      'Bar',
      // A suspends
      'Suspend! [A]',
      // But we keep rendering the siblings
      'B',
      'Loading...',
    ]);
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Resolve the data
    await resolveText('A');
    await waitForAll(['Foo', 'Bar', 'A', 'B']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="B" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('suspends siblings and later recovers each independently', async () => {
    // Render two sibling Suspense components
    ReactNoop.render(
      <Fragment>
        <Suspense fallback={<Text text="Loading A..." />}>
          <AsyncText text="A" />
        </Suspense>
        <Suspense fallback={<Text text="Loading B..." />}>
          <AsyncText text="B" />
        </Suspense>
      </Fragment>,
    );
    await waitForAll([
      'Suspend! [A]',
      'Loading A...',
      'Suspend! [B]',
      'Loading B...',
    ]);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Loading A..." />
        <span prop="Loading B..." />
      </>,
    );

    // Resolve first Suspense's promise so that it switches switches back to the
    // normal view. The second Suspense should still show the placeholder.
    await resolveText('A');

    await waitForAll(['A']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="Loading B..." />
      </>,
    );

    // Resolve the second Suspense's promise so that it switches back to the
    // normal view.
    await resolveText('B');

    await waitForAll(['B']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="B" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('continues rendering siblings after suspending', async () => {
    // A shell is needed. The update cause it to suspend.
    ReactNoop.render(<Suspense fallback={<Text text="Loading..." />} />);
    await waitForAll([]);
    // B suspends. Continue rendering the remaining siblings.
    React.startTransition(() => {
      ReactNoop.render(
        <Suspense fallback={<Text text="Loading..." />}>
          <Text text="A" />
          <AsyncText text="B" />
          <Text text="C" />
          <Text text="D" />
        </Suspense>,
      );
    });
    await waitForAll(['A', 'Suspend! [B]', 'C', 'D', 'Loading...']);
    // Did not commit yet.
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Wait for data to resolve
    await resolveText('B');
    await waitForAll(['A', 'B', 'C', 'D']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="B" />
        <span prop="C" />
        <span prop="D" />
      </>,
    );
  });

  // Second condition is redundant but guarantees that the test runs in prod.
  // TODO: Delete this feature flag.
  // @gate !replayFailedUnitOfWorkWithInvokeGuardedCallback || !__DEV__
  // @gate enableLegacyCache
  it('retries on error', async () => {
    class ErrorBoundary extends React.Component {
      state = {error: null};
      componentDidCatch(error) {
        this.setState({error});
      }
      reset() {
        this.setState({error: null});
      }
      render() {
        if (this.state.error !== null) {
          return <Text text={'Caught error: ' + this.state.error.message} />;
        }
        return this.props.children;
      }
    }

    const errorBoundary = React.createRef();
    function App({renderContent}) {
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          {renderContent ? (
            <ErrorBoundary ref={errorBoundary}>
              <AsyncText text="Result" ms={1000} />
            </ErrorBoundary>
          ) : null}
        </Suspense>
      );
    }

    ReactNoop.render(<App />);
    await waitForAll([]);
    expect(ReactNoop).toMatchRenderedOutput(null);

    React.startTransition(() => {
      ReactNoop.render(<App renderContent={true} />);
    });
    await waitForAll(['Suspend! [Result]', 'Loading...']);
    expect(ReactNoop).toMatchRenderedOutput(null);

    await rejectText('Result', new Error('Failed to load: Result'));

    await waitForAll([
      'Error! [Result]',

      // React retries one more time
      'Error! [Result]',

      // Errored again on retry. Now handle it.
      'Caught error: Failed to load: Result',
    ]);
    expect(ReactNoop).toMatchRenderedOutput(
      <span prop="Caught error: Failed to load: Result" />,
    );
  });

  // Second condition is redundant but guarantees that the test runs in prod.
  // TODO: Delete this feature flag.
  // @gate !replayFailedUnitOfWorkWithInvokeGuardedCallback || !__DEV__
  // @gate enableLegacyCache
  it('retries on error after falling back to a placeholder', async () => {
    class ErrorBoundary extends React.Component {
      state = {error: null};
      componentDidCatch(error) {
        this.setState({error});
      }
      reset() {
        this.setState({error: null});
      }
      render() {
        if (this.state.error !== null) {
          return <Text text={'Caught error: ' + this.state.error.message} />;
        }
        return this.props.children;
      }
    }

    const errorBoundary = React.createRef();
    function App() {
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          <ErrorBoundary ref={errorBoundary}>
            <AsyncText text="Result" ms={3000} />
          </ErrorBoundary>
        </Suspense>
      );
    }

    ReactNoop.render(<App />);
    await waitForAll(['Suspend! [Result]', 'Loading...']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);

    await rejectText('Result', new Error('Failed to load: Result'));

    await waitForAll([
      'Error! [Result]',

      // React retries one more time
      'Error! [Result]',

      // Errored again on retry. Now handle it.
      'Caught error: Failed to load: Result',
    ]);
    expect(ReactNoop).toMatchRenderedOutput(
      <span prop="Caught error: Failed to load: Result" />,
    );
  });

  // @gate enableLegacyCache
  it('can update at a higher priority while in a suspended state', async () => {
    function App(props) {
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          <Text text={props.highPri} />
          <AsyncText text={props.lowPri} />
        </Suspense>
      );
    }

    // Initial mount
    ReactNoop.render(<App highPri="A" lowPri="1" />);
    await waitForAll(['A', 'Suspend! [1]', 'Loading...']);
    await resolveText('1');
    await waitForAll(['A', '1']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="1" />
      </>,
    );

    // Update the low-pri text
    ReactNoop.render(<App highPri="A" lowPri="2" />);
    await waitForAll([
      'A',
      // Suspends
      'Suspend! [2]',
      'Loading...',
    ]);

    // While we're still waiting for the low-pri update to complete, update the
    // high-pri text at high priority.
    ReactNoop.flushSync(() => {
      ReactNoop.render(<App highPri="B" lowPri="1" />);
    });
    assertLog(['B', '1']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="B" />
        <span prop="1" />
      </>,
    );

    // Unblock the low-pri text and finish
    await resolveText('2');
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="B" />
        <span prop="1" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('keeps working on lower priority work after being pinged', async () => {
    // Advance the virtual time so that we're close to the edge of a bucket.
    ReactNoop.expire(149);

    function App(props) {
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          {props.showA && <AsyncText text="A" />}
          {props.showB && <Text text="B" />}
        </Suspense>
      );
    }

    ReactNoop.render(<App showA={false} showB={false} />);
    await waitForAll([]);
    expect(ReactNoop).toMatchRenderedOutput(null);

    React.startTransition(() => {
      ReactNoop.render(<App showA={true} showB={false} />);
    });
    await waitForAll(['Suspend! [A]', 'Loading...']);
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Advance React's virtual time by enough to fall into a new async bucket,
    // but not enough to expire the suspense timeout.
    ReactNoop.expire(120);
    React.startTransition(() => {
      ReactNoop.render(<App showA={true} showB={true} />);
    });
    await waitForAll(['Suspend! [A]', 'B', 'Loading...']);
    expect(ReactNoop).toMatchRenderedOutput(null);

    await resolveText('A');
    await waitForAll(['A', 'B']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="B" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('tries rendering a lower priority pending update even if a higher priority one suspends', async () => {
    function App(props) {
      if (props.hide) {
        return <Text text="(empty)" />;
      }
      return (
        <Suspense fallback="Loading...">
          <AsyncText ms={2000} text="Async" />
        </Suspense>
      );
    }

    // Schedule a default pri update and a low pri update, without rendering in between.
    // Default pri
    ReactNoop.render(<App />);
    // Low pri
    React.startTransition(() => {
      ReactNoop.render(<App hide={true} />);
    });

    await waitForAll([
      // The first update suspends
      'Suspend! [Async]',
      // but we have another pending update that we can work on
      '(empty)',
    ]);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="(empty)" />);
  });

  // Note: This test was written to test a heuristic used in the expiration
  // times model. Might not make sense in the new model.
  // TODO: This test doesn't over what it was originally designed to test.
  // Either rewrite or delete.
  it('tries each subsequent level after suspending', async () => {
    const root = ReactNoop.createRoot();

    function App({step, shouldSuspend}) {
      return (
        <Suspense fallback="Loading...">
          <Text text="Sibling" />
          {shouldSuspend ? (
            <AsyncText text={'Step ' + step} />
          ) : (
            <Text text={'Step ' + step} />
          )}
        </Suspense>
      );
    }

    function interrupt() {
      // React has a heuristic to batch all updates that occur within the same
      // event. This is a trick to circumvent that heuristic.
      ReactNoop.flushSync(() => {
        ReactNoop.renderToRootWithID(null, 'other-root');
      });
    }

    // Mount the Suspense boundary without suspending, so that the subsequent
    // updates suspend with a delay.
    await act(async () => {
      root.render(<App step={0} shouldSuspend={false} />);
    });
    await advanceTimers(1000);
    assertLog(['Sibling', 'Step 0']);

    // Schedule an update at several distinct expiration times
    await act(async () => {
      React.startTransition(() => {
        root.render(<App step={1} shouldSuspend={true} />);
      });
      Scheduler.unstable_advanceTime(1000);
      await waitFor(['Sibling']);
      interrupt();

      React.startTransition(() => {
        root.render(<App step={2} shouldSuspend={true} />);
      });
      Scheduler.unstable_advanceTime(1000);
      await waitFor(['Sibling']);
      interrupt();

      React.startTransition(() => {
        root.render(<App step={3} shouldSuspend={true} />);
      });
      Scheduler.unstable_advanceTime(1000);
      await waitFor(['Sibling']);
      interrupt();

      root.render(<App step={4} shouldSuspend={false} />);
    });

    assertLog(['Sibling', 'Step 4']);
  });

  // @gate enableLegacyCache
  it('forces an expiration after an update times out', async () => {
    ReactNoop.render(
      <Fragment>
        <Suspense fallback={<Text text="Loading..." />} />
      </Fragment>,
    );
    await waitForAll([]);

    ReactNoop.render(
      <Fragment>
        <Suspense fallback={<Text text="Loading..." />}>
          <AsyncText text="Async" />
        </Suspense>
        <Text text="Sync" />
      </Fragment>,
    );

    await waitForAll([
      // The async child suspends
      'Suspend! [Async]',
      // Render the placeholder
      'Loading...',
      // Continue on the sibling
      'Sync',
    ]);
    // The update hasn't expired yet, so we commit nothing.
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Advance both React's virtual time and Jest's timers by enough to expire
    // the update.
    ReactNoop.expire(10000);
    await advanceTimers(10000);
    assertLog([]);
    // Should have committed the placeholder.
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Loading..." />
        <span prop="Sync" />
      </>,
    );

    // Once the promise resolves, we render the suspended view
    await resolveText('Async');
    await waitForAll(['Async']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Async" />
        <span prop="Sync" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('switches to an inner fallback after suspending for a while', async () => {
    // Advance the virtual time so that we're closer to the edge of a bucket.
    ReactNoop.expire(200);

    ReactNoop.render(
      <Fragment>
        <Text text="Sync" />
        <Suspense fallback={<Text text="Loading outer..." />}>
          <AsyncText text="Outer content" ms={300} />
          <Suspense fallback={<Text text="Loading inner..." />}>
            <AsyncText text="Inner content" ms={1000} />
          </Suspense>
        </Suspense>
      </Fragment>,
    );

    await waitForAll([
      'Sync',
      // The async content suspends
      'Suspend! [Outer content]',
      'Suspend! [Inner content]',
      'Loading inner...',
      'Loading outer...',
    ]);
    // The outer loading state finishes immediately.
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Sync" />
        <span prop="Loading outer..." />
      </>,
    );

    // Resolve the outer promise.
    await resolveText('Outer content');
    await waitForAll([
      'Outer content',
      'Suspend! [Inner content]',
      'Loading inner...',
    ]);
    // Don't commit the inner placeholder yet.
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Sync" />
        <span prop="Loading outer..." />
      </>,
    );

    // Expire the inner timeout.
    ReactNoop.expire(500);
    await advanceTimers(500);
    // Now that 750ms have elapsed since the outer placeholder timed out,
    // we can timeout the inner placeholder.
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Sync" />
        <span prop="Outer content" />
        <span prop="Loading inner..." />
      </>,
    );

    // Finally, flush the inner promise. We should see the complete screen.
    await resolveText('Inner content');
    await waitForAll(['Inner content']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Sync" />
        <span prop="Outer content" />
        <span prop="Inner content" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('renders an expiration boundary synchronously', async () => {
    spyOnDev(console, 'error');
    // Synchronously render a tree that suspends
    ReactNoop.flushSync(() =>
      ReactNoop.render(
        <Fragment>
          <Suspense fallback={<Text text="Loading..." />}>
            <AsyncText text="Async" />
          </Suspense>
          <Text text="Sync" />
        </Fragment>,
      ),
    );
    assertLog([
      // The async child suspends
      'Suspend! [Async]',
      // We immediately render the fallback UI
      'Loading...',
      // Continue on the sibling
      'Sync',
    ]);
    // The tree commits synchronously
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Loading..." />
        <span prop="Sync" />
      </>,
    );

    // Once the promise resolves, we render the suspended view
    await resolveText('Async');
    await waitForAll(['Async']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Async" />
        <span prop="Sync" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('suspending inside an expired expiration boundary will bubble to the next one', async () => {
    ReactNoop.flushSync(() =>
      ReactNoop.render(
        <Fragment>
          <Suspense fallback={<Text text="Loading (outer)..." />}>
            <Suspense fallback={<AsyncText text="Loading (inner)..." />}>
              <AsyncText text="Async" />
            </Suspense>
            <Text text="Sync" />
          </Suspense>
        </Fragment>,
      ),
    );
    assertLog([
      'Suspend! [Async]',
      'Suspend! [Loading (inner)...]',
      'Sync',
      'Loading (outer)...',
    ]);
    // The tree commits synchronously
    expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading (outer)..." />);
  });

  // @gate enableLegacyCache
  it('expires early by default', async () => {
    ReactNoop.render(
      <Fragment>
        <Suspense fallback={<Text text="Loading..." />} />
      </Fragment>,
    );
    await waitForAll([]);

    ReactNoop.render(
      <Fragment>
        <Suspense fallback={<Text text="Loading..." />}>
          <AsyncText text="Async" />
        </Suspense>
        <Text text="Sync" />
      </Fragment>,
    );

    await waitForAll([
      // The async child suspends
      'Suspend! [Async]',
      'Loading...',
      // Continue on the sibling
      'Sync',
    ]);
    // The update hasn't expired yet, so we commit nothing.
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Advance both React's virtual time and Jest's timers by enough to trigger
    // the timeout, but not by enough to flush the promise or reach the true
    // expiration time.
    ReactNoop.expire(2000);
    await advanceTimers(2000);
    await waitForAll([]);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Loading..." />
        <span prop="Sync" />
      </>,
    );

    // Once the promise resolves, we render the suspended view
    await resolveText('Async');
    await waitForAll(['Async']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Async" />
        <span prop="Sync" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('does not expire for transitions', async () => {
    ReactNoop.render(
      <Fragment>
        <Suspense fallback={<Text text="Loading..." />} />
      </Fragment>,
    );
    await waitForAll([]);

    React.startTransition(() => {
      ReactNoop.render(
        <Fragment>
          <Suspense fallback={<Text text="Loading..." />}>
            <AsyncText text="Async" />
          </Suspense>
          <Text text="Sync" />
        </Fragment>,
      );
    });

    await waitForAll([
      // The async child suspends
      'Suspend! [Async]',
      'Loading...',
      // Continue on the sibling
      'Sync',
    ]);
    // The update hasn't expired yet, so we commit nothing.
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Advance both React's virtual time and Jest's timers,
    // but not by enough to flush the promise or reach the true expiration time.
    ReactNoop.expire(2000);
    await advanceTimers(2000);
    expect(ReactNoop).toMatchRenderedOutput(null);

    await waitForAll([]);
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Once the promise resolves, we render the suspended view
    await resolveText('Async');
    await waitForAll(['Async', 'Sync']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Async" />
        <span prop="Sync" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('resolves successfully even if fallback render is pending', async () => {
    const root = ReactNoop.createRoot();
    root.render(
      <>
        <Suspense fallback={<Text text="Loading..." />} />
      </>,
    );
    await waitForAll([]);
    expect(root).toMatchRenderedOutput(null);
    React.startTransition(() => {
      root.render(
        <>
          <Suspense fallback={<Text text="Loading..." />}>
            <AsyncText text="Async" />
            <Text text="Sibling" />
          </Suspense>
        </>,
      );
    });
    await waitFor(['Suspend! [Async]', 'Sibling']);

    await resolveText('Async');

    await waitForAll(['Async', 'Sibling']);
    expect(root).toMatchRenderedOutput(
      <>
        <span prop="Async" />
        <span prop="Sibling" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('in concurrent mode, does not error when an update suspends without a Suspense boundary during a sync update', () => {
    // NOTE: We may change this to be a warning in the future.
    expect(() => {
      ReactNoop.flushSync(() => {
        ReactNoop.render(<AsyncText text="Async" />);
      });
    }).not.toThrow();
  });

  // @gate enableLegacyCache
  it('in legacy mode, errors when an update suspends without a Suspense boundary during a sync update', () => {
    const root = ReactNoop.createLegacyRoot();
    expect(() => root.render(<AsyncText text="Async" />)).toThrow(
      'A component suspended while responding to synchronous input.',
    );
  });

  // @gate enableLegacyCache
  it('a Suspense component correctly handles more than one suspended child', async () => {
    ReactNoop.render(
      <Suspense fallback={<Text text="Loading..." />}>
        <AsyncText text="A" />
        <AsyncText text="B" />
      </Suspense>,
    );
    await waitForAll(['Suspend! [A]', 'Suspend! [B]', 'Loading...']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);

    await resolveText('A');
    await resolveText('B');

    await waitForAll(['A', 'B']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="B" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('can resume rendering earlier than a timeout', async () => {
    ReactNoop.render(<Suspense fallback={<Text text="Loading..." />} />);
    await waitForAll([]);

    React.startTransition(() => {
      ReactNoop.render(
        <Suspense fallback={<Text text="Loading..." />}>
          <AsyncText text="Async" />
        </Suspense>,
      );
    });
    await waitForAll(['Suspend! [Async]', 'Loading...']);
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Resolve the promise
    await resolveText('Async');
    await waitForAll(['Async']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="Async" />);
  });

  // @gate enableLegacyCache
  it('starts working on an update even if its priority falls between two suspended levels', async () => {
    function App(props) {
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          {props.text === 'C' || props.text === 'S' ? (
            <Text text={props.text} />
          ) : (
            <AsyncText text={props.text} />
          )}
        </Suspense>
      );
    }

    // First mount without suspending. This ensures we already have content
    // showing so that subsequent updates will suspend.
    ReactNoop.render(<App text="S" />);
    await waitForAll(['S']);

    // Schedule an update, and suspend for up to 5 seconds.
    React.startTransition(() => ReactNoop.render(<App text="A" />));
    await waitForAll(['Suspend! [A]', 'Loading...']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="S" />);

    // Advance time until right before it expires.
    await advanceTimers(4999);
    ReactNoop.expire(4999);
    await waitForAll([]);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="S" />);

    // Schedule another low priority update.
    React.startTransition(() => ReactNoop.render(<App text="B" />));
    await waitForAll(['Suspend! [B]', 'Loading...']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="S" />);

    // Schedule a regular update. Its expiration time will fall between
    // the expiration times of the previous two updates.
    ReactNoop.render(<App text="C" />);
    await waitForAll(['C']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="C" />);

    // Flush the remaining work.
    await resolveText('A');
    await resolveText('B');
    await waitForAll([]);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="C" />);
  });

  // TODO: This test was written against the old Expiration Times
  // implementation. It doesn't really test what it was intended to test
  // anymore, because all updates to the same queue get entangled together.
  // Even if they haven't expired. Consider either deleting or rewriting.
  // @gate enableLegacyCache
  it('flushes all expired updates in a single batch', async () => {
    class Foo extends React.Component {
      componentDidUpdate() {
        Scheduler.unstable_yieldValue('Commit: ' + this.props.text);
      }
      componentDidMount() {
        Scheduler.unstable_yieldValue('Commit: ' + this.props.text);
      }
      render() {
        return (
          <Suspense fallback={<Text text="Loading..." />}>
            <AsyncText text={this.props.text} />
          </Suspense>
        );
      }
    }

    ReactNoop.render(<Foo text="" />);
    ReactNoop.expire(1000);
    jest.advanceTimersByTime(1000);
    ReactNoop.render(<Foo text="go" />);
    ReactNoop.expire(1000);
    jest.advanceTimersByTime(1000);
    ReactNoop.render(<Foo text="good" />);
    ReactNoop.expire(1000);
    jest.advanceTimersByTime(1000);
    ReactNoop.render(<Foo text="goodbye" />);

    await waitForAll(['Suspend! [goodbye]', 'Loading...', 'Commit: goodbye']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);

    await resolveText('goodbye');
    expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);

    await waitForAll(['goodbye']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="goodbye" />);
  });

  // @gate enableLegacyCache
  it('a suspended update that expires', async () => {
    // Regression test. This test used to fall into an infinite loop.
    function ExpensiveText({text}) {
      // This causes the update to expire.
      Scheduler.unstable_advanceTime(10000);
      // Then something suspends.
      return <AsyncText text={text} />;
    }

    function App() {
      return (
        <Suspense fallback="Loading...">
          <ExpensiveText text="A" />
          <ExpensiveText text="B" />
          <ExpensiveText text="C" />
        </Suspense>
      );
    }

    ReactNoop.render(<App />);
    await waitForAll(['Suspend! [A]', 'Suspend! [B]', 'Suspend! [C]']);
    expect(ReactNoop).toMatchRenderedOutput('Loading...');

    await resolveText('A');
    await resolveText('B');
    await resolveText('C');

    await waitForAll(['A', 'B', 'C']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="B" />
        <span prop="C" />
      </>,
    );
  });

  describe('legacy mode mode', () => {
    // @gate enableLegacyCache
    it('times out immediately', async () => {
      function App() {
        return (
          <Suspense fallback={<Text text="Loading..." />}>
            <AsyncText text="Result" />
          </Suspense>
        );
      }

      // Times out immediately, ignoring the specified threshold.
      ReactNoop.renderLegacySyncRoot(<App />);
      assertLog(['Suspend! [Result]', 'Loading...']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);

      await act(async () => {
        resolveText('Result');
      });

      assertLog(['Result']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="Result" />);
    });

    // @gate enableLegacyCache
    it('times out immediately when Suspense is in legacy mode', async () => {
      class UpdatingText extends React.Component {
        state = {step: 1};
        render() {
          return <AsyncText text={`Step: ${this.state.step}`} />;
        }
      }

      function Spinner() {
        return (
          <Fragment>
            <Text text="Loading (1)" />
            <Text text="Loading (2)" />
            <Text text="Loading (3)" />
          </Fragment>
        );
      }

      const text = React.createRef(null);
      function App() {
        return (
          <Suspense fallback={<Spinner />}>
            <UpdatingText ref={text} />
            <Text text="Sibling" />
          </Suspense>
        );
      }

      // Initial mount.
      await seedNextTextCache('Step: 1');
      ReactNoop.renderLegacySyncRoot(<App />);
      assertLog(['Step: 1', 'Sibling']);
      expect(ReactNoop).toMatchRenderedOutput(
        <>
          <span prop="Step: 1" />
          <span prop="Sibling" />
        </>,
      );

      // Update.
      text.current.setState({step: 2}, () =>
        Scheduler.unstable_yieldValue('Update did commit'),
      );

      expect(ReactNoop.flushNextYield()).toEqual([
        'Suspend! [Step: 2]',
        'Loading (1)',
        'Loading (2)',
        'Loading (3)',
        'Update did commit',
      ]);
      expect(ReactNoop).toMatchRenderedOutput(
        <>
          <span hidden={true} prop="Step: 1" />
          <span hidden={true} prop="Sibling" />
          <span prop="Loading (1)" />
          <span prop="Loading (2)" />
          <span prop="Loading (3)" />
        </>,
      );

      await act(async () => {
        resolveText('Step: 2');
      });
      assertLog(['Step: 2']);
      expect(ReactNoop).toMatchRenderedOutput(
        <>
          <span prop="Step: 2" />
          <span prop="Sibling" />
        </>,
      );
    });

    // @gate enableLegacyCache
    it('does not re-render siblings in loose mode', async () => {
      class TextWithLifecycle extends React.Component {
        componentDidMount() {
          Scheduler.unstable_yieldValue(`Mount [${this.props.text}]`);
        }
        componentDidUpdate() {
          Scheduler.unstable_yieldValue(`Update [${this.props.text}]`);
        }
        render() {
          return <Text {...this.props} />;
        }
      }

      class AsyncTextWithLifecycle extends React.Component {
        componentDidMount() {
          Scheduler.unstable_yieldValue(`Mount [${this.props.text}]`);
        }
        componentDidUpdate() {
          Scheduler.unstable_yieldValue(`Update [${this.props.text}]`);
        }
        render() {
          return <AsyncText {...this.props} />;
        }
      }

      function App() {
        return (
          <Suspense fallback={<TextWithLifecycle text="Loading..." />}>
            <TextWithLifecycle text="A" />
            <AsyncTextWithLifecycle text="B" />
            <TextWithLifecycle text="C" />
          </Suspense>
        );
      }

      ReactNoop.renderLegacySyncRoot(<App />, () =>
        Scheduler.unstable_yieldValue('Commit root'),
      );
      assertLog([
        'A',
        'Suspend! [B]',
        'C',

        'Loading...',
        'Mount [A]',
        'Mount [B]',
        'Mount [C]',
        // This should be a mount, not an update.
        'Mount [Loading...]',
        'Commit root',
      ]);
      expect(ReactNoop).toMatchRenderedOutput(
        <>
          <span hidden={true} prop="A" />
          <span hidden={true} prop="C" />

          <span prop="Loading..." />
        </>,
      );

      await act(async () => {
        resolveText('B');
      });

      assertLog(['B']);
      expect(ReactNoop).toMatchRenderedOutput(
        <>
          <span prop="A" />
          <span prop="B" />
          <span prop="C" />
        </>,
      );
    });

    // @gate enableLegacyCache
    it('suspends inside constructor', async () => {
      class AsyncTextInConstructor extends React.Component {
        constructor(props) {
          super(props);
          const text = props.text;
          Scheduler.unstable_yieldValue('constructor');
          readText(text);
          this.state = {text};
        }
        componentDidMount() {
          Scheduler.unstable_yieldValue('componentDidMount');
        }
        render() {
          Scheduler.unstable_yieldValue(this.state.text);
          return <span prop={this.state.text} />;
        }
      }

      ReactNoop.renderLegacySyncRoot(
        <Suspense fallback={<Text text="Loading..." />}>
          <AsyncTextInConstructor text="Hi" />
        </Suspense>,
      );

      assertLog(['constructor', 'Suspend! [Hi]', 'Loading...']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);

      await act(async () => {
        resolveText('Hi');
      });

      assertLog(['constructor', 'Hi', 'componentDidMount']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="Hi" />);
    });

    // @gate enableLegacyCache
    it('does not infinite loop if fallback contains lifecycle method', async () => {
      class Fallback extends React.Component {
        state = {
          name: 'foo',
        };
        componentDidMount() {
          this.setState({
            name: 'bar',
          });
        }
        render() {
          return <Text text="Loading..." />;
        }
      }

      class Demo extends React.Component {
        render() {
          return (
            <Suspense fallback={<Fallback />}>
              <AsyncText text="Hi" />
            </Suspense>
          );
        }
      }

      ReactNoop.renderLegacySyncRoot(<Demo />);

      assertLog([
        'Suspend! [Hi]',
        'Loading...',
        // Re-render due to lifecycle update
        'Loading...',
      ]);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);
      await act(async () => {
        resolveText('Hi');
      });
      assertLog(['Hi']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="Hi" />);
    });

    if (global.__PERSISTENT__) {
      // @gate enableLegacyCache
      it('hides/unhides suspended children before layout effects fire (persistent)', async () => {
        const {useRef, useLayoutEffect} = React;

        function Parent() {
          const child = useRef(null);

          useLayoutEffect(() => {
            Scheduler.unstable_yieldValue(ReactNoop.getPendingChildrenAsJSX());
          });

          return (
            <span ref={child} hidden={false}>
              <AsyncText text="Hi" />
            </span>
          );
        }

        function App(props) {
          return (
            <Suspense fallback={<Text text="Loading..." />}>
              <Parent />
            </Suspense>
          );
        }

        ReactNoop.renderLegacySyncRoot(<App middleText="B" />);

        assertLog([
          'Suspend! [Hi]',
          'Loading...',
          // The child should have already been hidden
          <>
            <span hidden={true} />
            <span prop="Loading..." />
          </>,
        ]);

        await act(async () => {
          resolveText('Hi');
        });
        assertLog(['Hi']);
      });
    } else {
      // @gate enableLegacyCache
      it('hides/unhides suspended children before layout effects fire (mutation)', async () => {
        const {useRef, useLayoutEffect} = React;

        function Parent() {
          const child = useRef(null);

          useLayoutEffect(() => {
            Scheduler.unstable_yieldValue(
              'Child is hidden: ' + child.current.hidden,
            );
          });

          return (
            <span ref={child} hidden={false}>
              <AsyncText text="Hi" />
            </span>
          );
        }

        function App(props) {
          return (
            <Suspense fallback={<Text text="Loading..." />}>
              <Parent />
            </Suspense>
          );
        }

        ReactNoop.renderLegacySyncRoot(<App middleText="B" />);

        assertLog([
          'Suspend! [Hi]',
          'Loading...',
          // The child should have already been hidden
          'Child is hidden: true',
        ]);

        await act(async () => {
          resolveText('Hi');
        });

        assertLog(['Hi']);
      });
    }

    // @gate enableLegacyCache
    it('handles errors in the return path of a component that suspends', async () => {
      // Covers an edge case where an error is thrown inside the complete phase
      // of a component that is in the return path of a component that suspends.
      // The second error should also be handled (i.e. able to be captured by
      // an error boundary.
      class ErrorBoundary extends React.Component {
        state = {error: null};
        static getDerivedStateFromError(error, errorInfo) {
          return {error};
        }
        render() {
          if (this.state.error) {
            return `Caught an error: ${this.state.error.message}`;
          }
          return this.props.children;
        }
      }

      ReactNoop.renderLegacySyncRoot(
        <ErrorBoundary>
          <Suspense fallback="Loading...">
            <errorInCompletePhase>
              <AsyncText text="Async" />
            </errorInCompletePhase>
          </Suspense>
        </ErrorBoundary>,
      );

      assertLog(['Suspend! [Async]']);
      expect(ReactNoop).toMatchRenderedOutput(
        'Caught an error: Error in host config.',
      );
    });

    it('does not drop mounted effects', async () => {
      const never = {then() {}};

      let setShouldSuspend;
      function App() {
        const [shouldSuspend, _setShouldSuspend] = React.useState(0);
        setShouldSuspend = _setShouldSuspend;
        return (
          <Suspense fallback="Loading...">
            <Child shouldSuspend={shouldSuspend} />
          </Suspense>
        );
      }

      function Child({shouldSuspend}) {
        if (shouldSuspend) {
          throw never;
        }

        React.useEffect(() => {
          Scheduler.unstable_yieldValue('Mount');
          return () => {
            Scheduler.unstable_yieldValue('Unmount');
          };
        }, []);

        return 'Child';
      }

      const root = ReactNoop.createLegacyRoot(null);
      await act(async () => {
        root.render(<App />);
      });
      assertLog(['Mount']);
      expect(root).toMatchRenderedOutput('Child');

      // Suspend the child. This puts it into an inconsistent state.
      await act(async () => {
        setShouldSuspend(true);
      });
      expect(root).toMatchRenderedOutput('Loading...');

      // Unmount everything
      await act(async () => {
        root.render(null);
      });
      assertLog(['Unmount']);
    });
  });

  // @gate enableLegacyCache
  it('does not call lifecycles of a suspended component', async () => {
    class TextWithLifecycle extends React.Component {
      componentDidMount() {
        Scheduler.unstable_yieldValue(`Mount [${this.props.text}]`);
      }
      componentDidUpdate() {
        Scheduler.unstable_yieldValue(`Update [${this.props.text}]`);
      }
      componentWillUnmount() {
        Scheduler.unstable_yieldValue(`Unmount [${this.props.text}]`);
      }
      render() {
        return <Text {...this.props} />;
      }
    }

    class AsyncTextWithLifecycle extends React.Component {
      componentDidMount() {
        Scheduler.unstable_yieldValue(`Mount [${this.props.text}]`);
      }
      componentDidUpdate() {
        Scheduler.unstable_yieldValue(`Update [${this.props.text}]`);
      }
      componentWillUnmount() {
        Scheduler.unstable_yieldValue(`Unmount [${this.props.text}]`);
      }
      render() {
        const text = this.props.text;
        readText(text);
        Scheduler.unstable_yieldValue(text);
        return <span prop={text} />;
      }
    }

    function App() {
      return (
        <Suspense fallback={<TextWithLifecycle text="Loading..." />}>
          <TextWithLifecycle text="A" />
          <AsyncTextWithLifecycle text="B" />
          <TextWithLifecycle text="C" />
        </Suspense>
      );
    }

    ReactNoop.renderLegacySyncRoot(<App />, () =>
      Scheduler.unstable_yieldValue('Commit root'),
    );
    assertLog([
      'A',
      'Suspend! [B]',
      'C',
      'Loading...',

      'Mount [A]',
      // B's lifecycle should not fire because it suspended
      // 'Mount [B]',
      'Mount [C]',
      'Mount [Loading...]',
      'Commit root',
    ]);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span hidden={true} prop="A" />
        <span hidden={true} prop="C" />
        <span prop="Loading..." />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('does not call lifecycles of a suspended component (hooks)', async () => {
    function TextWithLifecycle(props) {
      React.useLayoutEffect(() => {
        Scheduler.unstable_yieldValue(`Layout Effect [${props.text}]`);
        return () => {
          Scheduler.unstable_yieldValue(
            `Destroy Layout Effect [${props.text}]`,
          );
        };
      }, [props.text]);
      React.useEffect(() => {
        Scheduler.unstable_yieldValue(`Effect [${props.text}]`);
        return () => {
          Scheduler.unstable_yieldValue(`Destroy Effect [${props.text}]`);
        };
      }, [props.text]);
      return <Text {...props} />;
    }

    function AsyncTextWithLifecycle(props) {
      React.useLayoutEffect(() => {
        Scheduler.unstable_yieldValue(`Layout Effect [${props.text}]`);
        return () => {
          Scheduler.unstable_yieldValue(
            `Destroy Layout Effect [${props.text}]`,
          );
        };
      }, [props.text]);
      React.useEffect(() => {
        Scheduler.unstable_yieldValue(`Effect [${props.text}]`);
        return () => {
          Scheduler.unstable_yieldValue(`Destroy Effect [${props.text}]`);
        };
      }, [props.text]);
      const text = props.text;
      readText(text);
      Scheduler.unstable_yieldValue(text);
      return <span prop={text} />;
    }

    function App({text}) {
      return (
        <Suspense fallback={<TextWithLifecycle text="Loading..." />}>
          <TextWithLifecycle text="A" />
          <AsyncTextWithLifecycle text={text} />
          <TextWithLifecycle text="C" />
        </Suspense>
      );
    }

    ReactNoop.renderLegacySyncRoot(<App text="B" />, () =>
      Scheduler.unstable_yieldValue('Commit root'),
    );
    assertLog([
      'A',
      'Suspend! [B]',
      'C',
      'Loading...',

      'Layout Effect [A]',
      // B's effect should not fire because it suspended
      // 'Layout Effect [B]',
      'Layout Effect [C]',
      'Layout Effect [Loading...]',
      'Commit root',
    ]);

    await waitForAll([
      'Effect [A]',
      // B's effect should not fire because it suspended
      // 'Effect [B]',
      'Effect [C]',
      'Effect [Loading...]',
    ]);

    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span hidden={true} prop="A" />
        <span hidden={true} prop="C" />
        <span prop="Loading..." />
      </>,
    );

    await act(async () => {
      resolveText('B');
    });

    assertLog([
      'B',
      'Destroy Layout Effect [Loading...]',
      'Layout Effect [B]',
      'Destroy Effect [Loading...]',
      'Effect [B]',
    ]);

    // Update
    ReactNoop.renderLegacySyncRoot(<App text="B2" />, () =>
      Scheduler.unstable_yieldValue('Commit root'),
    );

    assertLog([
      'A',
      'Suspend! [B2]',
      'C',
      'Loading...',

      // B2's effect should not fire because it suspended
      // 'Layout Effect [B2]',
      'Layout Effect [Loading...]',
      'Commit root',
    ]);

    await waitForAll([
      // B2's effect should not fire because it suspended
      // 'Effect [B2]',
      'Effect [Loading...]',
    ]);

    await act(async () => {
      resolveText('B2');
    });

    assertLog([
      'B2',
      'Destroy Layout Effect [Loading...]',
      'Destroy Layout Effect [B]',
      'Layout Effect [B2]',
      'Destroy Effect [Loading...]',
      'Destroy Effect [B]',
      'Effect [B2]',
    ]);
  });

  // @gate enableLegacyCache
  it('suspends for longer if something took a long (CPU bound) time to render', async () => {
    function Foo({renderContent}) {
      Scheduler.unstable_yieldValue('Foo');
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          {renderContent ? <AsyncText text="A" /> : null}
        </Suspense>
      );
    }

    ReactNoop.render(<Foo />);
    await waitForAll(['Foo']);

    React.startTransition(() => {
      ReactNoop.render(<Foo renderContent={true} />);
    });
    Scheduler.unstable_advanceTime(100);
    await advanceTimers(100);
    await waitFor(['Foo']);
    // For some reason it took a long time to render Foo.
    Scheduler.unstable_advanceTime(1250);
    await advanceTimers(1250);
    await waitForAll([
      // A suspends
      'Suspend! [A]',
      'Loading...',
    ]);
    // We're now suspended and we haven't shown anything yet.
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Flush some of the time
    Scheduler.unstable_advanceTime(450);
    await advanceTimers(450);
    await waitForAll([]);
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Eventually we'll show the fallback.
    Scheduler.unstable_advanceTime(500);
    await advanceTimers(500);
    await waitForAll([]);
    // Since this is a transition, we never fallback.
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Flush the promise completely
    await resolveText('A');
    await waitForAll(['Foo', 'A']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);
  });

  // @gate enableLegacyCache
  it('does not suspends if a fallback has been shown for a long time', async () => {
    function Foo() {
      Scheduler.unstable_yieldValue('Foo');
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          <AsyncText text="A" />
          <Suspense fallback={<Text text="Loading more..." />}>
            <AsyncText text="B" />
          </Suspense>
        </Suspense>
      );
    }

    ReactNoop.render(<Foo />);
    await waitForAll([
      'Foo',
      // A suspends
      'Suspend! [A]',
      // B suspends
      'Suspend! [B]',
      'Loading more...',
      'Loading...',
    ]);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);

    await resolveText('A');
    // Wait a long time.
    Scheduler.unstable_advanceTime(5000);
    await advanceTimers(5000);

    await waitForAll([
      'A',
      // B still suspends
      'Suspend! [B]',
      'Loading more...',
    ]);

    // Because we've already been waiting for so long we've exceeded
    // our threshold and we show the next level immediately.
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="Loading more..." />
      </>,
    );

    // Flush the last promise completely
    await resolveText('B');
    await waitForAll(['B']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="B" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('does suspend if a fallback has been shown for a short time', async () => {
    function Foo() {
      Scheduler.unstable_yieldValue('Foo');
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          <AsyncText text="A" />
          <Suspense fallback={<Text text="Loading more..." />}>
            <AsyncText text="B" />
          </Suspense>
        </Suspense>
      );
    }

    ReactNoop.render(<Foo />);
    await waitForAll([
      'Foo',
      // A suspends
      'Suspend! [A]',
      // B suspends
      'Suspend! [B]',
      'Loading more...',
      'Loading...',
    ]);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);

    await resolveText('A');

    await waitForAll([
      'A',
      // B still suspends
      'Suspend! [B]',
      'Loading more...',
    ]);
    // Because we've already been waiting for so long we can
    // wait a bit longer. Still nothing...
    expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);

    await resolveText('B');

    // Before we commit another Promise resolves.
    // We're still showing the first loading state.
    expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);
    await waitForAll(['A', 'B']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="B" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('does not suspend for very long after a higher priority update', async () => {
    function Foo({renderContent}) {
      Scheduler.unstable_yieldValue('Foo');
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          {renderContent ? <AsyncText text="A" /> : null}
        </Suspense>
      );
    }

    ReactNoop.render(<Foo />);
    await waitForAll(['Foo']);

    React.startTransition(() => {
      ReactNoop.render(<Foo renderContent={true} />);
    });
    await waitFor(['Foo']);

    // Advance some time.
    Scheduler.unstable_advanceTime(100);
    await advanceTimers(100);

    await waitForAll([
      // A suspends
      'Suspend! [A]',
      'Loading...',
    ]);

    // We're now suspended and we haven't shown anything yet.
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Flush some of the time
    Scheduler.unstable_advanceTime(500);
    jest.advanceTimersByTime(500);

    await waitForAll([]);
    // Transitions never fallback.
    expect(ReactNoop).toMatchRenderedOutput(null);
  });

  // TODO: flip to "warns" when this is implemented again.
  // @gate enableLegacyCache
  it('does not warn when a low priority update suspends inside a high priority update for functional components', async () => {
    let _setShow;
    function App() {
      const [show, setShow] = React.useState(false);
      _setShow = setShow;
      return (
        <Suspense fallback="Loading...">
          {show && <AsyncText text="A" />}
        </Suspense>
      );
    }

    await act(async () => {
      ReactNoop.render(<App />);
    });

    // TODO: assert toErrorDev() when the warning is implemented again.
    act(() => {
      ReactNoop.flushSync(() => _setShow(true));
    });
  });

  // TODO: flip to "warns" when this is implemented again.
  // @gate enableLegacyCache
  it('does not warn when a low priority update suspends inside a high priority update for class components', async () => {
    let show;
    class App extends React.Component {
      state = {show: false};

      render() {
        show = () => this.setState({show: true});
        return (
          <Suspense fallback="Loading...">
            {this.state.show && <AsyncText text="A" />}
          </Suspense>
        );
      }
    }

    await act(async () => {
      ReactNoop.render(<App />);
    });

    // TODO: assert toErrorDev() when the warning is implemented again.
    act(() => {
      ReactNoop.flushSync(() => show());
    });
  });

  // @gate enableLegacyCache
  it('does not warn about wrong Suspense priority if no new fallbacks are shown', async () => {
    let showB;
    class App extends React.Component {
      state = {showB: false};

      render() {
        showB = () => this.setState({showB: true});
        return (
          <Suspense fallback="Loading...">
            {<AsyncText text="A" />}
            {this.state.showB && <AsyncText text="B" />}
          </Suspense>
        );
      }
    }

    await act(async () => {
      ReactNoop.render(<App />);
    });

    assertLog(['Suspend! [A]']);
    expect(ReactNoop).toMatchRenderedOutput('Loading...');

    act(() => {
      ReactNoop.flushSync(() => showB());
    });

    assertLog(['Suspend! [A]', 'Suspend! [B]']);
  });

  // TODO: flip to "warns" when this is implemented again.
  // @gate enableLegacyCache
  it(
    'does not warn when component that triggered user-blocking update is between Suspense boundary ' +
      'and component that suspended',
    async () => {
      let _setShow;
      function A() {
        const [show, setShow] = React.useState(false);
        _setShow = setShow;
        return show && <AsyncText text="A" />;
      }
      function App() {
        return (
          <Suspense fallback="Loading...">
            <A />
          </Suspense>
        );
      }
      await act(async () => {
        ReactNoop.render(<App />);
      });

      // TODO: assert toErrorDev() when the warning is implemented again.
      act(() => {
        ReactNoop.flushSync(() => _setShow(true));
      });
    },
  );

  // @gate enableLegacyCache
  it('normal priority updates suspending do not warn for class components', async () => {
    let show;
    class App extends React.Component {
      state = {show: false};

      render() {
        show = () => this.setState({show: true});
        return (
          <Suspense fallback="Loading...">
            {this.state.show && <AsyncText text="A" />}
          </Suspense>
        );
      }
    }

    await act(async () => {
      ReactNoop.render(<App />);
    });

    // also make sure lowpriority is okay
    await act(async () => show(true));

    assertLog(['Suspend! [A]']);
    await resolveText('A');

    expect(ReactNoop).toMatchRenderedOutput('Loading...');
  });

  // @gate enableLegacyCache
  it('normal priority updates suspending do not warn for functional components', async () => {
    let _setShow;
    function App() {
      const [show, setShow] = React.useState(false);
      _setShow = setShow;
      return (
        <Suspense fallback="Loading...">
          {show && <AsyncText text="A" />}
        </Suspense>
      );
    }

    await act(async () => {
      ReactNoop.render(<App />);
    });

    // also make sure lowpriority is okay
    await act(async () => _setShow(true));

    assertLog(['Suspend! [A]']);
    await resolveText('A');

    expect(ReactNoop).toMatchRenderedOutput('Loading...');
  });

  // @gate enableLegacyCache && enableSuspenseAvoidThisFallback
  it('shows the parent fallback if the inner fallback should be avoided', async () => {
    function Foo({showC}) {
      Scheduler.unstable_yieldValue('Foo');
      return (
        <Suspense fallback={<Text text="Initial load..." />}>
          <Suspense
            unstable_avoidThisFallback={true}
            fallback={<Text text="Updating..." />}>
            <AsyncText text="A" />
            {showC ? <AsyncText text="C" /> : null}
          </Suspense>
          <Text text="B" />
        </Suspense>
      );
    }

    ReactNoop.render(<Foo />);
    await waitForAll(['Foo', 'Suspend! [A]', 'B', 'Initial load...']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="Initial load..." />);

    // Eventually we resolve and show the data.
    await resolveText('A');
    await waitForAll(['A', 'B']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="B" />
      </>,
    );

    // Update to show C
    ReactNoop.render(<Foo showC={true} />);
    await waitForAll(['Foo', 'A', 'Suspend! [C]', 'Updating...', 'B']);
    // Flush to skip suspended time.
    Scheduler.unstable_advanceTime(600);
    await advanceTimers(600);
    // Since the optional suspense boundary is already showing its content,
    // we have to use the inner fallback instead.
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" hidden={true} />
        <span prop="Updating..." />
        <span prop="B" />
      </>,
    );

    // Later we load the data.
    await resolveText('C');
    await waitForAll(['A', 'C']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="C" />
        <span prop="B" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('does not show the parent fallback if the inner fallback is not defined', async () => {
    function Foo({showC}) {
      Scheduler.unstable_yieldValue('Foo');
      return (
        <Suspense fallback={<Text text="Initial load..." />}>
          <Suspense>
            <AsyncText text="A" />
            {showC ? <AsyncText text="C" /> : null}
          </Suspense>
          <Text text="B" />
        </Suspense>
      );
    }

    ReactNoop.render(<Foo />);
    await waitForAll([
      'Foo',
      'Suspend! [A]',
      'B',
      // null
    ]);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="B" />);

    // Eventually we resolve and show the data.
    await resolveText('A');
    await waitForAll(['A']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="B" />
      </>,
    );

    // Update to show C
    ReactNoop.render(<Foo showC={true} />);
    await waitForAll([
      'Foo',
      'A',
      'Suspend! [C]',
      // null
      'B',
    ]);
    // Flush to skip suspended time.
    Scheduler.unstable_advanceTime(600);
    await advanceTimers(600);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" hidden={true} />
        <span prop="B" />
      </>,
    );

    // Later we load the data.
    await resolveText('C');
    await waitForAll(['A', 'C']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="C" />
        <span prop="B" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('favors showing the inner fallback for nested top level avoided fallback', async () => {
    function Foo({showB}) {
      Scheduler.unstable_yieldValue('Foo');
      return (
        <Suspense
          unstable_avoidThisFallback={true}
          fallback={<Text text="Loading A..." />}>
          <Text text="A" />
          <Suspense
            unstable_avoidThisFallback={true}
            fallback={<Text text="Loading B..." />}>
            <AsyncText text="B" />
          </Suspense>
        </Suspense>
      );
    }

    ReactNoop.render(<Foo />);
    await waitForAll(['Foo', 'A', 'Suspend! [B]', 'Loading B...']);
    // Flush to skip suspended time.
    Scheduler.unstable_advanceTime(600);
    await advanceTimers(600);

    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="Loading B..." />
      </>,
    );
  });

  // @gate enableLegacyCache && enableSuspenseAvoidThisFallback
  it('keeps showing an avoided parent fallback if it is already showing', async () => {
    function Foo({showB}) {
      Scheduler.unstable_yieldValue('Foo');
      return (
        <Suspense fallback={<Text text="Initial load..." />}>
          <Suspense
            unstable_avoidThisFallback={true}
            fallback={<Text text="Loading A..." />}>
            <Text text="A" />
            {showB ? (
              <Suspense
                unstable_avoidThisFallback={true}
                fallback={<Text text="Loading B..." />}>
                <AsyncText text="B" />
              </Suspense>
            ) : null}
          </Suspense>
        </Suspense>
      );
    }

    ReactNoop.render(<Foo />);
    await waitForAll(['Foo', 'A']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);

    React.startTransition(() => {
      ReactNoop.render(<Foo showB={true} />);
    });

    await waitForAll(['Foo', 'A', 'Suspend! [B]', 'Loading B...']);
    // Still suspended.
    expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);

    // Flush to skip suspended time.
    Scheduler.unstable_advanceTime(600);
    await advanceTimers(600);

    // Transitions never fall back.
    expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);
  });

  // @gate enableLegacyCache
  it('keeps showing an undefined fallback if it is already showing', async () => {
    function Foo({showB}) {
      Scheduler.unstable_yieldValue('Foo');
      return (
        <Suspense fallback={<Text text="Initial load..." />}>
          <Suspense fallback={undefined}>
            <Text text="A" />
            {showB ? (
              <Suspense fallback={undefined}>
                <AsyncText text="B" />
              </Suspense>
            ) : null}
          </Suspense>
        </Suspense>
      );
    }

    ReactNoop.render(<Foo />);
    await waitForAll(['Foo', 'A']);
    expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);

    React.startTransition(() => {
      ReactNoop.render(<Foo showB={true} />);
    });

    await waitForAll([
      'Foo',
      'A',
      'Suspend! [B]',
      // Null
    ]);
    // Still suspended.
    expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);

    // Flush to skip suspended time.
    Scheduler.unstable_advanceTime(600);
    await advanceTimers(600);

    // Transitions never fall back.
    expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);
  });

  // @gate enableLegacyCache
  it('commits a suspended idle pri render within a reasonable time', async () => {
    function Foo({renderContent}) {
      return (
        <Fragment>
          <Suspense fallback={<Text text="Loading A..." />}>
            {renderContent ? <AsyncText text="A" /> : null}
          </Suspense>
        </Fragment>
      );
    }

    ReactNoop.render(<Foo />);
    await waitForAll([]);

    ReactNoop.render(<Foo renderContent={1} />);

    // Took a long time to render. This is to ensure we get a long suspense time.
    // Could also use something like startTransition to simulate this.
    Scheduler.unstable_advanceTime(1500);
    await advanceTimers(1500);

    await waitForAll(['Suspend! [A]', 'Loading A...']);
    // We're still suspended.
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Schedule an update at idle pri.
    ReactNoop.idleUpdates(() => ReactNoop.render(<Foo renderContent={2} />));
    await waitForAll([]);

    // We're still suspended.
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Advance time a little bit.
    Scheduler.unstable_advanceTime(150);
    await advanceTimers(150);

    // We should not have committed yet because we had a long suspense time.
    expect(ReactNoop).toMatchRenderedOutput(null);

    // Flush to skip suspended time.
    Scheduler.unstable_advanceTime(600);
    await advanceTimers(600);

    expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading A..." />);
  });

  describe('startTransition', () => {
    // @gate enableLegacyCache
    it('top level render', async () => {
      function App({page}) {
        return (
          <Suspense fallback={<Text text="Loading..." />}>
            <AsyncText text={page} />
          </Suspense>
        );
      }

      // Initial render.
      React.startTransition(() => ReactNoop.render(<App page="A" />));

      await waitForAll(['Suspend! [A]', 'Loading...']);
      // Only a short time is needed to unsuspend the initial loading state.
      Scheduler.unstable_advanceTime(400);
      await advanceTimers(400);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);

      // Later we load the data.
      await resolveText('A');
      await waitForAll(['A']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);

      // Start transition.
      React.startTransition(() => ReactNoop.render(<App page="B" />));

      await waitForAll(['Suspend! [B]', 'Loading...']);
      Scheduler.unstable_advanceTime(100000);
      await advanceTimers(100000);
      // Even after lots of time has passed, we have still not yet flushed the
      // loading state.
      expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);
      // Later we load the data.
      await resolveText('B');
      await waitForAll(['B']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="B" />);
    });

    // @gate enableLegacyCache
    it('hooks', async () => {
      let transitionToPage;
      function App() {
        const [page, setPage] = React.useState('none');
        transitionToPage = setPage;
        if (page === 'none') {
          return null;
        }
        return (
          <Suspense fallback={<Text text="Loading..." />}>
            <AsyncText text={page} />
          </Suspense>
        );
      }

      ReactNoop.render(<App />);
      await waitForAll([]);

      // Initial render.
      await act(async () => {
        React.startTransition(() => transitionToPage('A'));

        await waitForAll(['Suspend! [A]', 'Loading...']);
        // Only a short time is needed to unsuspend the initial loading state.
        Scheduler.unstable_advanceTime(400);
        await advanceTimers(400);
        expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);
      });

      // Later we load the data.
      await resolveText('A');
      await waitForAll(['A']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);

      // Start transition.
      await act(async () => {
        React.startTransition(() => transitionToPage('B'));

        await waitForAll(['Suspend! [B]', 'Loading...']);
        Scheduler.unstable_advanceTime(100000);
        await advanceTimers(100000);
        // Even after lots of time has passed, we have still not yet flushed the
        // loading state.
        expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);
      });
      // Later we load the data.
      await resolveText('B');
      await waitForAll(['B']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="B" />);
    });

    // @gate enableLegacyCache
    it('classes', async () => {
      let transitionToPage;
      class App extends React.Component {
        state = {page: 'none'};
        render() {
          transitionToPage = page => this.setState({page});
          const page = this.state.page;
          if (page === 'none') {
            return null;
          }
          return (
            <Suspense fallback={<Text text="Loading..." />}>
              <AsyncText text={page} />
            </Suspense>
          );
        }
      }

      ReactNoop.render(<App />);
      await waitForAll([]);

      // Initial render.
      await act(async () => {
        React.startTransition(() => transitionToPage('A'));

        await waitForAll(['Suspend! [A]', 'Loading...']);
        // Only a short time is needed to unsuspend the initial loading state.
        Scheduler.unstable_advanceTime(400);
        await advanceTimers(400);
        expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);
      });

      // Later we load the data.
      await resolveText('A');
      await waitForAll(['A']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);

      // Start transition.
      await act(async () => {
        React.startTransition(() => transitionToPage('B'));

        await waitForAll(['Suspend! [B]', 'Loading...']);
        Scheduler.unstable_advanceTime(100000);
        await advanceTimers(100000);
        // Even after lots of time has passed, we have still not yet flushed the
        // loading state.
        expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);
      });
      // Later we load the data.
      await resolveText('B');
      await waitForAll(['B']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="B" />);
    });
  });

  describe('delays transitions when using React.startTransition', () => {
    // @gate enableLegacyCache
    it('top level render', async () => {
      function App({page}) {
        return (
          <Suspense fallback={<Text text="Loading..." />}>
            <AsyncText text={page} />
          </Suspense>
        );
      }

      // Initial render.
      React.startTransition(() => ReactNoop.render(<App page="A" />));

      await waitForAll(['Suspend! [A]', 'Loading...']);
      // Only a short time is needed to unsuspend the initial loading state.
      Scheduler.unstable_advanceTime(400);
      await advanceTimers(400);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);

      // Later we load the data.
      await resolveText('A');
      await waitForAll(['A']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);

      // Start transition.
      React.startTransition(() => ReactNoop.render(<App page="B" />));

      await waitForAll(['Suspend! [B]', 'Loading...']);
      Scheduler.unstable_advanceTime(2999);
      await advanceTimers(2999);
      // Since the timeout is infinite (or effectively infinite),
      // we have still not yet flushed the loading state.
      expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);

      // Later we load the data.
      await resolveText('B');
      await waitForAll(['B']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="B" />);

      // Start a long (infinite) transition.
      React.startTransition(() => ReactNoop.render(<App page="C" />));
      await waitForAll(['Suspend! [C]', 'Loading...']);

      // Even after lots of time has passed, we have still not yet flushed the
      // loading state.
      Scheduler.unstable_advanceTime(100000);
      await advanceTimers(100000);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="B" />);
    });

    // @gate enableLegacyCache
    it('hooks', async () => {
      let transitionToPage;
      function App() {
        const [page, setPage] = React.useState('none');
        transitionToPage = setPage;
        if (page === 'none') {
          return null;
        }
        return (
          <Suspense fallback={<Text text="Loading..." />}>
            <AsyncText text={page} />
          </Suspense>
        );
      }

      ReactNoop.render(<App />);
      await waitForAll([]);

      // Initial render.
      await act(async () => {
        React.startTransition(() => transitionToPage('A'));

        await waitForAll(['Suspend! [A]', 'Loading...']);
        // Only a short time is needed to unsuspend the initial loading state.
        Scheduler.unstable_advanceTime(400);
        await advanceTimers(400);
        expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);
      });

      // Later we load the data.
      await resolveText('A');
      await waitForAll(['A']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);

      // Start transition.
      await act(async () => {
        React.startTransition(() => transitionToPage('B'));

        await waitForAll(['Suspend! [B]', 'Loading...']);

        Scheduler.unstable_advanceTime(2999);
        await advanceTimers(2999);
        // Since the timeout is infinite (or effectively infinite),
        // we have still not yet flushed the loading state.
        expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);
      });

      // Later we load the data.
      await resolveText('B');
      await waitForAll(['B']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="B" />);

      // Start a long (infinite) transition.
      await act(async () => {
        React.startTransition(() => transitionToPage('C'));

        await waitForAll(['Suspend! [C]', 'Loading...']);

        // Even after lots of time has passed, we have still not yet flushed the
        // loading state.
        Scheduler.unstable_advanceTime(100000);
        await advanceTimers(100000);
        expect(ReactNoop).toMatchRenderedOutput(<span prop="B" />);
      });
    });

    // @gate enableLegacyCache
    it('classes', async () => {
      let transitionToPage;
      class App extends React.Component {
        state = {page: 'none'};
        render() {
          transitionToPage = page => this.setState({page});
          const page = this.state.page;
          if (page === 'none') {
            return null;
          }
          return (
            <Suspense fallback={<Text text="Loading..." />}>
              <AsyncText text={page} />
            </Suspense>
          );
        }
      }

      ReactNoop.render(<App />);
      await waitForAll([]);

      // Initial render.
      await act(async () => {
        React.startTransition(() => transitionToPage('A'));

        await waitForAll(['Suspend! [A]', 'Loading...']);
        // Only a short time is needed to unsuspend the initial loading state.
        Scheduler.unstable_advanceTime(400);
        await advanceTimers(400);
        expect(ReactNoop).toMatchRenderedOutput(<span prop="Loading..." />);
      });

      // Later we load the data.
      await resolveText('A');
      await waitForAll(['A']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);

      // Start transition.
      await act(async () => {
        React.startTransition(() => transitionToPage('B'));

        await waitForAll(['Suspend! [B]', 'Loading...']);
        Scheduler.unstable_advanceTime(2999);
        await advanceTimers(2999);
        // Since the timeout is infinite (or effectively infinite),
        // we have still not yet flushed the loading state.
        expect(ReactNoop).toMatchRenderedOutput(<span prop="A" />);
      });

      // Later we load the data.
      await resolveText('B');
      await waitForAll(['B']);
      expect(ReactNoop).toMatchRenderedOutput(<span prop="B" />);

      // Start a long (infinite) transition.
      await act(async () => {
        React.startTransition(() => transitionToPage('C'));

        await waitForAll(['Suspend! [C]', 'Loading...']);

        // Even after lots of time has passed, we have still not yet flushed the
        // loading state.
        Scheduler.unstable_advanceTime(100000);
        await advanceTimers(100000);
        expect(ReactNoop).toMatchRenderedOutput(<span prop="B" />);
      });
    });
  });

  // @gate enableLegacyCache && enableSuspenseAvoidThisFallback
  it('do not show placeholder when updating an avoided boundary with startTransition', async () => {
    function App({page}) {
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          <Text text="Hi!" />
          <Suspense
            fallback={<Text text={'Loading ' + page + '...'} />}
            unstable_avoidThisFallback={true}>
            <AsyncText text={page} />
          </Suspense>
        </Suspense>
      );
    }

    // Initial render.
    ReactNoop.render(<App page="A" />);
    await waitForAll(['Hi!', 'Suspend! [A]', 'Loading...']);
    await resolveText('A');
    await waitForAll(['Hi!', 'A']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Hi!" />
        <span prop="A" />
      </>,
    );

    // Start transition.
    React.startTransition(() => ReactNoop.render(<App page="B" />));

    await waitForAll(['Hi!', 'Suspend! [B]', 'Loading B...']);

    // Suspended
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Hi!" />
        <span prop="A" />
      </>,
    );
    Scheduler.unstable_advanceTime(1800);
    await advanceTimers(1800);
    await waitForAll([]);
    // We should still be suspended here because this loading state should be avoided.
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Hi!" />
        <span prop="A" />
      </>,
    );
    await resolveText('B');
    await waitForAll(['Hi!', 'B']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Hi!" />
        <span prop="B" />
      </>,
    );
  });

  // @gate enableLegacyCache && enableSuspenseAvoidThisFallback
  it('do not show placeholder when mounting an avoided boundary with startTransition', async () => {
    function App({page}) {
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          <Text text="Hi!" />
          {page === 'A' ? (
            <Text text="A" />
          ) : (
            <Suspense
              fallback={<Text text={'Loading ' + page + '...'} />}
              unstable_avoidThisFallback={true}>
              <AsyncText text={page} />
            </Suspense>
          )}
        </Suspense>
      );
    }

    // Initial render.
    ReactNoop.render(<App page="A" />);
    await waitForAll(['Hi!', 'A']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Hi!" />
        <span prop="A" />
      </>,
    );

    // Start transition.
    React.startTransition(() => ReactNoop.render(<App page="B" />));

    await waitForAll(['Hi!', 'Suspend! [B]', 'Loading B...']);

    // Suspended
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Hi!" />
        <span prop="A" />
      </>,
    );
    Scheduler.unstable_advanceTime(1800);
    await advanceTimers(1800);
    await waitForAll([]);
    // We should still be suspended here because this loading state should be avoided.
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Hi!" />
        <span prop="A" />
      </>,
    );
    await resolveText('B');
    await waitForAll(['Hi!', 'B']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <span prop="Hi!" />
        <span prop="B" />
      </>,
    );
  });

  // TODO: This test is specifically about avoided commits that suspend for a
  // JND. We may remove this behavior.
  // @gate enableLegacyCache
  it("suspended commit remains suspended even if there's another update at same expiration", async () => {
    // Regression test
    function App({text}) {
      return (
        <Suspense fallback="Loading...">
          <AsyncText text={text} />
        </Suspense>
      );
    }

    const root = ReactNoop.createRoot();
    await act(async () => {
      root.render(<App text="Initial" />);
    });
    assertLog(['Suspend! [Initial]']);

    // Resolve initial render
    await act(async () => {
      await resolveText('Initial');
    });
    assertLog(['Initial']);
    expect(root).toMatchRenderedOutput(<span prop="Initial" />);

    await act(async () => {
      // Update. Since showing a fallback would hide content that's already
      // visible, it should suspend for a JND without committing.
      React.startTransition(() => {
        root.render(<App text="First update" />);
      });
      await waitForAll(['Suspend! [First update]']);

      // Should not display a fallback
      expect(root).toMatchRenderedOutput(<span prop="Initial" />);

      // Update again. This should also suspend for a JND.
      React.startTransition(() => {
        root.render(<App text="Second update" />);
      });
      await waitForAll(['Suspend! [Second update]']);

      // Should not display a fallback
      expect(root).toMatchRenderedOutput(<span prop="Initial" />);
    });
  });

  it('regression test: resets current "debug phase" after suspending', async () => {
    function App() {
      return (
        <Suspense fallback="Loading...">
          <Foo suspend={false} />
        </Suspense>
      );
    }

    const thenable = {then() {}};

    let foo;
    class Foo extends React.Component {
      state = {suspend: false};
      render() {
        foo = this;

        if (this.state.suspend) {
          Scheduler.unstable_yieldValue('Suspend!');
          throw thenable;
        }

        return <Text text="Foo" />;
      }
    }

    const root = ReactNoop.createRoot();
    await act(async () => {
      root.render(<App />);
    });

    assertLog(['Foo']);

    await act(async () => {
      foo.setState({suspend: true});

      await waitFor(['Suspend!']);

      // Then when this setState happens, React would incorrectly fire a warning
      // about updates that happen the render phase (only fired by classes).
      foo.setState({suspend: false});
    });

    assertLog([
      // First setState
      'Foo',
    ]);
    expect(root).toMatchRenderedOutput(<span prop="Foo" />);
  });

  // @gate enableLegacyCache && enableLegacyHidden
  it('should not render hidden content while suspended on higher pri', async () => {
    function Offscreen() {
      Scheduler.unstable_yieldValue('Offscreen');
      return 'Offscreen';
    }
    function App({showContent}) {
      React.useLayoutEffect(() => {
        Scheduler.unstable_yieldValue('Commit');
      });
      return (
        <>
          <LegacyHiddenDiv mode="hidden">
            <Offscreen />
          </LegacyHiddenDiv>
          <Suspense fallback={<Text text="Loading..." />}>
            {showContent ? <AsyncText text="A" ms={2000} /> : null}
          </Suspense>
        </>
      );
    }

    // Initial render.
    ReactNoop.render(<App showContent={false} />);
    await waitFor(['Commit']);
    expect(ReactNoop).toMatchRenderedOutput(<div hidden={true} />);

    // Start transition.
    React.startTransition(() => {
      ReactNoop.render(<App showContent={true} />);
    });

    await waitForAll(['Suspend! [A]', 'Loading...']);
    await resolveText('A');
    await waitFor(['A', 'Commit']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <div hidden={true} />
        <span prop="A" />
      </>,
    );
    await waitForAll(['Offscreen']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <div hidden={true}>Offscreen</div>
        <span prop="A" />
      </>,
    );
  });

  // @gate enableLegacyCache && enableLegacyHidden
  it('should be able to unblock higher pri content before suspended hidden', async () => {
    function Offscreen() {
      Scheduler.unstable_yieldValue('Offscreen');
      return 'Offscreen';
    }
    function App({showContent}) {
      React.useLayoutEffect(() => {
        Scheduler.unstable_yieldValue('Commit');
      });
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          <LegacyHiddenDiv mode="hidden">
            <AsyncText text="A" />
            <Offscreen />
          </LegacyHiddenDiv>
          {showContent ? <AsyncText text="A" /> : null}
        </Suspense>
      );
    }

    // Initial render.
    ReactNoop.render(<App showContent={false} />);
    await waitFor(['Commit']);
    expect(ReactNoop).toMatchRenderedOutput(<div hidden={true} />);

    await waitFor(['Suspend! [A]']);

    // Start transition.
    React.startTransition(() => {
      ReactNoop.render(<App showContent={true} />);
    });

    await waitForAll(['Suspend! [A]', 'Loading...']);
    await resolveText('A');
    await waitFor(['A', 'Commit']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <div hidden={true} />
        <span prop="A" />
      </>,
    );
    await waitForAll(['A', 'Offscreen']);
    expect(ReactNoop).toMatchRenderedOutput(
      <>
        <div hidden={true}>
          <span prop="A" />
          Offscreen
        </div>
        <span prop="A" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it(
    'multiple updates originating inside a Suspense boundary at different ' +
      'priority levels are not dropped',
    async () => {
      const {useState} = React;
      const root = ReactNoop.createRoot();

      function Parent() {
        return (
          <>
            <Suspense fallback={<Text text="Loading..." />}>
              <Child />
            </Suspense>
          </>
        );
      }

      let setText;
      function Child() {
        const [text, _setText] = useState('A');
        setText = _setText;
        return <AsyncText text={text} />;
      }

      await seedNextTextCache('A');
      await act(async () => {
        root.render(<Parent />);
      });
      assertLog(['A']);
      expect(root).toMatchRenderedOutput(<span prop="A" />);

      await act(async () => {
        // Schedule two updates that originate inside the Suspense boundary.
        // The first one causes the boundary to suspend. The second one is at
        // lower priority and unsuspends the tree.
        ReactNoop.discreteUpdates(() => {
          setText('B');
        });
        // Update to a value that has already resolved
        await resolveText('C');
        setText('C');
      });
      assertLog([
        // First we attempt the high pri update. It suspends.
        'Suspend! [B]',
        'Loading...',
        // Then we attempt the low pri update, which finishes successfully.
        'C',
      ]);
      expect(root).toMatchRenderedOutput(<span prop="C" />);
    },
  );

  // @gate enableLegacyCache
  it(
    'multiple updates originating inside a Suspense boundary at different ' +
      'priority levels are not dropped, including Idle updates',
    async () => {
      const {useState} = React;
      const root = ReactNoop.createRoot();

      function Parent() {
        return (
          <>
            <Suspense fallback={<Text text="Loading..." />}>
              <Child />
            </Suspense>
          </>
        );
      }

      let setText;
      function Child() {
        const [text, _setText] = useState('A');
        setText = _setText;
        return <AsyncText text={text} />;
      }

      await seedNextTextCache('A');
      await act(async () => {
        root.render(<Parent />);
      });
      assertLog(['A']);
      expect(root).toMatchRenderedOutput(<span prop="A" />);

      await act(async () => {
        // Schedule two updates that originate inside the Suspense boundary.
        // The first one causes the boundary to suspend. The second one is at
        // lower priority and unsuspends it by hiding the async component.
        setText('B');

        await resolveText('C');
        ReactNoop.idleUpdates(() => {
          setText('C');
        });

        await waitForAll([
          // First we attempt the high pri update. It suspends.
          'Suspend! [B]',
          'Loading...',
        ]);

        // Commit the placeholder to unblock the Idle update.
        await advanceTimers(250);
        expect(root).toMatchRenderedOutput(
          <>
            <span hidden={true} prop="A" />
            <span prop="Loading..." />
          </>,
        );

        await waitForAll(['C']);
        expect(root).toMatchRenderedOutput(<span prop="C" />);
      });
    },
  );

  // @gate enableLegacyCache
  it(
    'fallback component can update itself even after a high pri update to ' +
      'the primary tree suspends',
    async () => {
      const {useState} = React;
      const root = ReactNoop.createRoot();

      let setAppText;
      function App() {
        const [text, _setText] = useState('A');
        setAppText = _setText;
        return (
          <>
            <Suspense fallback={<Fallback />}>
              <AsyncText text={text} />
            </Suspense>
          </>
        );
      }

      let setFallbackText;
      function Fallback() {
        const [text, _setText] = useState('Loading...');
        setFallbackText = _setText;
        return <Text text={text} />;
      }

      // Resolve the initial tree
      await seedNextTextCache('A');
      await act(async () => {
        root.render(<App />);
      });
      assertLog(['A']);
      expect(root).toMatchRenderedOutput(<span prop="A" />);

      await act(async () => {
        // Schedule an update inside the Suspense boundary that suspends.
        setAppText('B');
        await waitForAll(['Suspend! [B]', 'Loading...']);
      });

      expect(root).toMatchRenderedOutput(
        <>
          <span hidden={true} prop="A" />
          <span prop="Loading..." />
        </>,
      );

      // Schedule a default pri update on the boundary, and a lower pri update
      // on the fallback. We're testing to make sure the fallback can still
      // update even though the primary tree is suspended.
      await act(async () => {
        setAppText('C');
        React.startTransition(() => {
          setFallbackText('Still loading...');
        });
      });

      assertLog([
        // First try to render the high pri update. Still suspended.
        'Suspend! [C]',
        'Loading...',

        // In the expiration times model, once the high pri update suspends,
        // we can't be sure if there's additional work at a lower priority
        // that might unblock the tree. We do know that there's a lower
        // priority update *somewhere* in the entire root, though (the update
        // to the fallback). So we try rendering one more time, just in case.
        // TODO: We shouldn't need to do this with lanes, because we always
        // know exactly which lanes have pending work in each tree.
        'Suspend! [C]',

        // Then complete the update to the fallback.
        'Still loading...',
      ]);
      expect(root).toMatchRenderedOutput(
        <>
          <span hidden={true} prop="A" />
          <span prop="Still loading..." />
        </>,
      );
    },
  );

  // @gate enableLegacyCache
  it(
    'regression: primary fragment fiber is not always part of setState ' +
      'return path',
    async () => {
      // Reproduces a bug where updates inside a suspended tree are dropped
      // because the fragment fiber we insert to wrap the hidden children is not
      // part of the return path, so it doesn't get marked during setState.
      const {useState} = React;
      const root = ReactNoop.createRoot();

      function Parent() {
        return (
          <>
            <Suspense fallback={<Text text="Loading..." />}>
              <Child />
            </Suspense>
          </>
        );
      }

      let setText;
      function Child() {
        const [text, _setText] = useState('A');
        setText = _setText;
        return <AsyncText text={text} />;
      }

      // Mount an initial tree. Resolve A so that it doesn't suspend.
      await seedNextTextCache('A');
      await act(async () => {
        root.render(<Parent />);
      });
      assertLog(['A']);
      // At this point, the setState return path follows current fiber.
      expect(root).toMatchRenderedOutput(<span prop="A" />);

      // Schedule another update. This will "flip" the alternate pairs.
      await resolveText('B');
      await act(async () => {
        setText('B');
      });
      assertLog(['B']);
      // Now the setState return path follows the *alternate* fiber.
      expect(root).toMatchRenderedOutput(<span prop="B" />);

      // Schedule another update. This time, we'll suspend.
      await act(async () => {
        setText('C');
      });
      assertLog(['Suspend! [C]', 'Loading...']);

      // Commit. This will insert a fragment fiber to wrap around the component
      // that triggered the update.
      await act(async () => {
        await advanceTimers(250);
      });
      // The fragment fiber is part of the current tree, but the setState return
      // path still follows the alternate path. That means the fragment fiber is
      // not part of the return path.
      expect(root).toMatchRenderedOutput(
        <>
          <span hidden={true} prop="B" />
          <span prop="Loading..." />
        </>,
      );

      // Update again. This should unsuspend the tree.
      await resolveText('D');
      await act(async () => {
        setText('D');
      });
      assertLog(['D']);
      expect(root).toMatchRenderedOutput(<span prop="D" />);
    },
  );

  // @gate enableLegacyCache
  it(
    'regression: primary fragment fiber is not always part of setState ' +
      'return path (another case)',
    async () => {
      // Reproduces a bug where updates inside a suspended tree are dropped
      // because the fragment fiber we insert to wrap the hidden children is not
      // part of the return path, so it doesn't get marked during setState.
      const {useState} = React;
      const root = ReactNoop.createRoot();

      function Parent() {
        return (
          <Suspense fallback={<Text text="Loading..." />}>
            <Child />
          </Suspense>
        );
      }

      let setText;
      function Child() {
        const [text, _setText] = useState('A');
        setText = _setText;
        return <AsyncText text={text} />;
      }

      // Mount an initial tree. Resolve A so that it doesn't suspend.
      await seedNextTextCache('A');
      await act(async () => {
        root.render(<Parent />);
      });
      assertLog(['A']);
      // At this point, the setState return path follows current fiber.
      expect(root).toMatchRenderedOutput(<span prop="A" />);

      // Schedule another update. This will "flip" the alternate pairs.
      await resolveText('B');
      await act(async () => {
        setText('B');
      });
      assertLog(['B']);
      // Now the setState return path follows the *alternate* fiber.
      expect(root).toMatchRenderedOutput(<span prop="B" />);

      // Schedule another update. This time, we'll suspend.
      await act(async () => {
        setText('C');
      });
      assertLog(['Suspend! [C]', 'Loading...']);

      // Commit. This will insert a fragment fiber to wrap around the component
      // that triggered the update.
      await act(async () => {
        await advanceTimers(250);
      });
      // The fragment fiber is part of the current tree, but the setState return
      // path still follows the alternate path. That means the fragment fiber is
      // not part of the return path.
      expect(root).toMatchRenderedOutput(
        <>
          <span hidden={true} prop="B" />
          <span prop="Loading..." />
        </>,
      );

      await act(async () => {
        // Schedule a normal pri update. This will suspend again.
        setText('D');

        // And another update at lower priority. This will unblock.
        await resolveText('E');
        ReactNoop.idleUpdates(() => {
          setText('E');
        });
      });
      assertLog(['Suspend! [D]', 'E']);
      expect(root).toMatchRenderedOutput(<span prop="E" />);
    },
  );

  // @gate enableLegacyCache
  it(
    'after showing fallback, should not flip back to primary content until ' +
      'the update that suspended finishes',
    async () => {
      const {useState, useEffect} = React;
      const root = ReactNoop.createRoot();

      let setOuterText;
      function Parent({step}) {
        const [text, _setText] = useState('A');
        setOuterText = _setText;
        return (
          <>
            <Text text={'Outer text: ' + text} />
            <Text text={'Outer step: ' + step} />
            <Suspense fallback={<Text text="Loading..." />}>
              <Child step={step} outerText={text} />
            </Suspense>
          </>
        );
      }

      let setInnerText;
      function Child({step, outerText}) {
        const [text, _setText] = useState('A');
        setInnerText = _setText;

        // This will log if the component commits in an inconsistent state
        useEffect(() => {
          if (text === outerText) {
            Scheduler.unstable_yieldValue('Commit Child');
          } else {
            Scheduler.unstable_yieldValue(
              'FIXME: Texts are inconsistent (tearing)',
            );
          }
        }, [text, outerText]);

        return (
          <>
            <AsyncText text={'Inner text: ' + text} />
            <Text text={'Inner step: ' + step} />
          </>
        );
      }

      // These always update simultaneously. They must be consistent.
      function setText(text) {
        setOuterText(text);
        setInnerText(text);
      }

      // Mount an initial tree. Resolve A so that it doesn't suspend.
      await seedNextTextCache('Inner text: A');
      await act(async () => {
        root.render(<Parent step={0} />);
      });
      assertLog([
        'Outer text: A',
        'Outer step: 0',
        'Inner text: A',
        'Inner step: 0',
        'Commit Child',
      ]);
      expect(root).toMatchRenderedOutput(
        <>
          <span prop="Outer text: A" />
          <span prop="Outer step: 0" />
          <span prop="Inner text: A" />
          <span prop="Inner step: 0" />
        </>,
      );

      // Update. This causes the inner component to suspend.
      await act(async () => {
        setText('B');
      });
      assertLog([
        'Outer text: B',
        'Outer step: 0',
        'Suspend! [Inner text: B]',
        'Inner step: 0',
        'Loading...',
      ]);
      // Commit the placeholder
      await advanceTimers(250);
      expect(root).toMatchRenderedOutput(
        <>
          <span prop="Outer text: B" />
          <span prop="Outer step: 0" />
          <span hidden={true} prop="Inner text: A" />
          <span hidden={true} prop="Inner step: 0" />
          <span prop="Loading..." />
        </>,
      );

      // Schedule a high pri update on the parent.
      await act(async () => {
        ReactNoop.discreteUpdates(() => {
          root.render(<Parent step={1} />);
        });
      });

      assertLog([
        'Outer text: B',
        'Outer step: 1',
        'Suspend! [Inner text: B]',
        'Inner step: 1',
        'Loading...',
      ]);
      expect(root).toMatchRenderedOutput(
        <>
          <span prop="Outer text: B" />
          <span prop="Outer step: 1" />
          <span hidden={true} prop="Inner text: A" />
          <span hidden={true} prop="Inner step: 0" />
          <span prop="Loading..." />
        </>,
      );

      // Now finish resolving the inner text
      await act(async () => {
        await resolveText('Inner text: B');
      });
      assertLog(['Inner text: B', 'Inner step: 1', 'Commit Child']);
      expect(root).toMatchRenderedOutput(
        <>
          <span prop="Outer text: B" />
          <span prop="Outer step: 1" />
          <span prop="Inner text: B" />
          <span prop="Inner step: 1" />
        </>,
      );
    },
  );

  // @gate enableLegacyCache
  it('a high pri update can unhide a boundary that suspended at a different level', async () => {
    const {useState, useEffect} = React;
    const root = ReactNoop.createRoot();

    let setOuterText;
    function Parent({step}) {
      const [text, _setText] = useState('A');
      setOuterText = _setText;
      return (
        <>
          <Text text={'Outer: ' + text + step} />
          <Suspense fallback={<Text text="Loading..." />}>
            <Child step={step} outerText={text} />
          </Suspense>
        </>
      );
    }

    let setInnerText;
    function Child({step, outerText}) {
      const [text, _setText] = useState('A');
      setInnerText = _setText;

      // This will log if the component commits in an inconsistent state
      useEffect(() => {
        if (text === outerText) {
          Scheduler.unstable_yieldValue('Commit Child');
        } else {
          Scheduler.unstable_yieldValue(
            'FIXME: Texts are inconsistent (tearing)',
          );
        }
      }, [text, outerText]);

      return (
        <>
          <AsyncText text={'Inner: ' + text + step} />
        </>
      );
    }

    // These always update simultaneously. They must be consistent.
    function setText(text) {
      setOuterText(text);
      setInnerText(text);
    }

    // Mount an initial tree. Resolve A so that it doesn't suspend.
    await seedNextTextCache('Inner: A0');
    await act(async () => {
      root.render(<Parent step={0} />);
    });
    assertLog(['Outer: A0', 'Inner: A0', 'Commit Child']);
    expect(root).toMatchRenderedOutput(
      <>
        <span prop="Outer: A0" />
        <span prop="Inner: A0" />
      </>,
    );

    // Update. This causes the inner component to suspend.
    await act(async () => {
      setText('B');
    });
    assertLog(['Outer: B0', 'Suspend! [Inner: B0]', 'Loading...']);
    // Commit the placeholder
    await advanceTimers(250);
    expect(root).toMatchRenderedOutput(
      <>
        <span prop="Outer: B0" />
        <span hidden={true} prop="Inner: A0" />
        <span prop="Loading..." />
      </>,
    );

    // Schedule a high pri update on the parent. This will unblock the content.
    await resolveText('Inner: B1');
    await act(async () => {
      ReactNoop.discreteUpdates(() => {
        root.render(<Parent step={1} />);
      });
    });

    assertLog(['Outer: B1', 'Inner: B1', 'Commit Child']);
    expect(root).toMatchRenderedOutput(
      <>
        <span prop="Outer: B1" />
        <span prop="Inner: B1" />
      </>,
    );
  });

  // Regression: https://github.com/facebook/react/issues/18486
  // @gate enableLegacyCache
  it('does not get stuck in pending state with render phase updates', async () => {
    let setTextWithShortTransition;
    let setTextWithLongTransition;

    function App() {
      const [isPending1, startShortTransition] = React.useTransition();
      const [isPending2, startLongTransition] = React.useTransition();
      const isPending = isPending1 || isPending2;
      const [text, setText] = React.useState('');
      const [mirror, setMirror] = React.useState('');

      if (text !== mirror) {
        // Render phase update was needed to repro the bug.
        setMirror(text);
      }

      setTextWithShortTransition = value => {
        startShortTransition(() => {
          setText(value);
        });
      };
      setTextWithLongTransition = value => {
        startLongTransition(() => {
          setText(value);
        });
      };

      return (
        <>
          {isPending ? <Text text="Pending..." /> : null}
          {text !== '' ? <AsyncText text={text} /> : <Text text={text} />}
        </>
      );
    }

    function Root() {
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          <App />
        </Suspense>
      );
    }

    const root = ReactNoop.createRoot();
    await act(async () => {
      root.render(<Root />);
    });
    assertLog(['']);
    expect(root).toMatchRenderedOutput(<span prop="" />);

    // Update to "a". That will suspend.
    await act(async () => {
      setTextWithShortTransition('a');
      await waitForAll(['Pending...', '', 'Suspend! [a]', 'Loading...']);
    });
    assertLog([]);
    expect(root).toMatchRenderedOutput(
      <>
        <span prop="Pending..." />
        <span prop="" />
      </>,
    );

    // Update to "b". That will suspend, too.
    await act(async () => {
      setTextWithLongTransition('b');
      await waitForAll([
        // Neither is resolved yet.
        'Pending...',
        '',
        'Suspend! [b]',
        'Loading...',
      ]);
    });
    assertLog([]);
    expect(root).toMatchRenderedOutput(
      <>
        <span prop="Pending..." />
        <span prop="" />
      </>,
    );

    // Resolve "a". But "b" is still pending.
    await act(async () => {
      await resolveText('a');

      await waitForAll(['Suspend! [b]', 'Loading...']);
      expect(root).toMatchRenderedOutput(
        <>
          <span prop="Pending..." />
          <span prop="" />
        </>,
      );

      // Resolve "b". This should remove the pending state.
      await act(async () => {
        await resolveText('b');
      });
      assertLog(['b']);
      // The bug was that the pending state got stuck forever.
      expect(root).toMatchRenderedOutput(<span prop="b" />);
    });
  });

  // @gate enableLegacyCache
  it('regression: #18657', async () => {
    const {useState} = React;

    let setText;
    function App() {
      const [text, _setText] = useState('A');
      setText = _setText;
      return <AsyncText text={text} />;
    }

    const root = ReactNoop.createRoot();
    await act(async () => {
      await seedNextTextCache('A');
      root.render(
        <Suspense fallback={<Text text="Loading..." />}>
          <App />
        </Suspense>,
      );
    });
    assertLog(['A']);
    expect(root).toMatchRenderedOutput(<span prop="A" />);

    await act(async () => {
      setText('B');
      ReactNoop.idleUpdates(() => {
        setText('B');
      });
      await waitForAll(['Suspend! [B]', 'Loading...']);

      // Commit the fallback. Now we'll try working on Idle.
      jest.runAllTimers();

      await waitForAll(['Suspend! [B]']);
    });

    await act(async () => {
      setText('B');
      await resolveText('B');
    });
    assertLog(['B']);
    expect(root).toMatchRenderedOutput(<span prop="B" />);
  });

  // @gate enableLegacyCache
  it('retries have lower priority than normal updates', async () => {
    const {useState} = React;

    let setText;
    function UpdatingText() {
      const [text, _setText] = useState('A');
      setText = _setText;
      return <Text text={text} />;
    }

    const root = ReactNoop.createRoot();
    await act(async () => {
      root.render(
        <>
          <UpdatingText />
          <Suspense fallback={<Text text="Loading..." />}>
            <AsyncText text="Async" />
          </Suspense>
        </>,
      );
    });
    assertLog(['A', 'Suspend! [Async]', 'Loading...']);
    expect(root).toMatchRenderedOutput(
      <>
        <span prop="A" />
        <span prop="Loading..." />
      </>,
    );

    await act(async () => {
      // Resolve the promise. This will trigger a retry.
      await resolveText('Async');
      // Before the retry happens, schedule a new update.
      setText('B');

      await waitForPaint(['B']);
      expect(root).toMatchRenderedOutput(
        <>
          <span prop="B" />
          <span prop="Loading..." />
        </>,
      );
    });
    assertLog(['Async']);
    expect(root).toMatchRenderedOutput(
      <>
        <span prop="B" />
        <span prop="Async" />
      </>,
    );
  });

  // @gate enableLegacyCache
  it('should fire effect clean-up when deleting suspended tree', async () => {
    const {useEffect} = React;

    function App({show}) {
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          <Child />
          {show && <AsyncText text="Async" />}
        </Suspense>
      );
    }

    function Child() {
      useEffect(() => {
        Scheduler.unstable_yieldValue('Mount Child');
        return () => {
          Scheduler.unstable_yieldValue('Unmount Child');
        };
      }, []);
      return <span prop="Child" />;
    }

    const root = ReactNoop.createRoot();

    await act(async () => {
      root.render(<App show={false} />);
    });
    assertLog(['Mount Child']);
    expect(root).toMatchRenderedOutput(<span prop="Child" />);

    await act(async () => {
      root.render(<App show={true} />);
    });
    assertLog(['Suspend! [Async]', 'Loading...']);
    expect(root).toMatchRenderedOutput(
      <>
        <span hidden={true} prop="Child" />
        <span prop="Loading..." />
      </>,
    );

    await act(async () => {
      root.render(null);
    });
    assertLog(['Unmount Child']);
  });

  // @gate enableLegacyCache
  it('should fire effect clean-up when deleting suspended tree (legacy)', async () => {
    const {useEffect} = React;

    function App({show}) {
      return (
        <Suspense fallback={<Text text="Loading..." />}>
          <Child />
          {show && <AsyncText text="Async" />}
        </Suspense>
      );
    }

    function Child() {
      useEffect(() => {
        Scheduler.unstable_yieldValue('Mount Child');
        return () => {
          Scheduler.unstable_yieldValue('Unmount Child');
        };
      }, []);
      return <span prop="Child" />;
    }

    const root = ReactNoop.createLegacyRoot();

    await act(async () => {
      root.render(<App show={false} />);
    });
    assertLog(['Mount Child']);
    expect(root).toMatchRenderedOutput(<span prop="Child" />);

    await act(async () => {
      root.render(<App show={true} />);
    });
    assertLog(['Suspend! [Async]', 'Loading...']);
    expect(root).toMatchRenderedOutput(
      <>
        <span hidden={true} prop="Child" />
        <span prop="Loading..." />
      </>,
    );

    await act(async () => {
      root.render(null);
    });
    assertLog(['Unmount Child']);
  });

  // @gate enableLegacyCache
  it(
    'regression test: pinging synchronously within the render phase ' +
      'does not unwind the stack',
    async () => {
      // This is a regression test that reproduces a very specific scenario that
      // used to cause a crash.
      const thenable = {
        then(resolve) {
          resolve('hi');
        },
        status: 'pending',
      };

      function ImmediatelyPings() {
        if (thenable.status === 'pending') {
          thenable.status = 'fulfilled';
          throw thenable;
        }
        return <Text text="Hi" />;
      }

      function App({showMore}) {
        return (
          <div>
            <Suspense fallback={<Text text="Loading..." />}>
              {showMore ? (
                <>
                  <AsyncText text="Async" />
                </>
              ) : null}
            </Suspense>
            {showMore ? (
              <Suspense>
                <ImmediatelyPings />
              </Suspense>
            ) : null}
          </div>
        );
      }

      // Initial render. This mounts a Suspense boundary, so that in the next
      // update we can trigger a "suspend with delay" scenario.
      const root = ReactNoop.createRoot();
      await act(async () => {
        root.render(<App showMore={false} />);
      });
      assertLog([]);
      expect(root).toMatchRenderedOutput(<div />);

      // Update. This will cause two separate trees to suspend. The first tree
      // will be inside an already mounted Suspense boundary, so it will trigger
      // a "suspend with delay". The second tree will be a new Suspense
      // boundary, but the thenable that is thrown will immediately call its
      // ping listener.
      //
      // Before the bug was fixed, this would lead to a `prepareFreshStack` call
      // that unwinds the work-in-progress stack. When that code was written, it
      // was expected that pings always happen from an asynchronous task (or
      // microtask). But this test shows an example where that's not the case.
      //
      // The fix was to check if we're in the render phase before calling
      // `prepareFreshStack`.
      await act(async () => {
        root.render(<App showMore={true} />);
      });
      assertLog(['Suspend! [Async]', 'Loading...', 'Hi']);
      expect(root).toMatchRenderedOutput(
        <div>
          <span prop="Loading..." />
          <span prop="Hi" />
        </div>,
      );
    },
  );
});
