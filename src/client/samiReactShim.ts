import * as StaticReact from 'react';

function getActiveReact(): typeof StaticReact {
  if (typeof window !== 'undefined') {
    const w = window as any;
    if (w.__SAMI_REACT) return w.__SAMI_REACT;
    if (w.React) return w.React;
  }
  return StaticReact;
}

export function useRef<T>(initialValue: T) {
  const r = getActiveReact();
  return (r.useRef || StaticReact.useRef)(initialValue);
}

export function useState<S>(initialState: S | (() => S)) {
  const r = getActiveReact();
  return (r.useState || StaticReact.useState)(initialState);
}

export function useEffect(effect: StaticReact.EffectCallback, deps?: StaticReact.DependencyList) {
  const r = getActiveReact();
  return (r.useEffect || StaticReact.useEffect)(effect, deps);
}

export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: StaticReact.DependencyList) {
  const r = getActiveReact();
  return (r.useCallback || StaticReact.useCallback)(callback, deps);
}

export function useMemo<T>(factory: () => T, deps: StaticReact.DependencyList) {
  const r = getActiveReact();
  return (r.useMemo || StaticReact.useMemo)(factory, deps);
}

const ReactProxy = new Proxy(StaticReact, {
  get(_target, prop) {
    const active = getActiveReact() as any;
    const val = active[prop];
    if (typeof val === 'function') {
      return val.bind(active);
    }
    return val !== undefined ? val : (StaticReact as any)[prop];
  },
});

export default ReactProxy;
