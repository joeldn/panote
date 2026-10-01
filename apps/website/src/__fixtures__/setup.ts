// jsdom has no scrolling; the Shell scrolls on every page change.
if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
}
