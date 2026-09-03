// Properties that we allow a provider to set on a `SelectList` via a
// `ListController` instance.
const ALLOWED_PROPS_IN_LIST_CONTROLLER = new Set([
  "status",
  "emptyMessage",
  "loadingMessage",
  "loadingBadge",
]);

function validateListControllerProps(props) {
  return Object.keys(props).every((k) => ALLOWED_PROPS_IN_LIST_CONTROLLER.has(k));
}

/**
 * A class for setting various UI properties on a symbol list palette. This is a
 * privilege given to the “main” (or _exclusive_) provider for a given task.
 *
 * This is how we allow a provider to communicate its state to the UI without
 * giving it full control over the `SelectList` used to show results.
 */
class ListController {
  constructor(list) {
    this.list = list;
  }

  set(props) {
    if (!validateListControllerProps(props)) {
      console.warn("Provider gave invalid properties to symbol list UI:", props);
    }
    return this.list.update(props);
  }

  clear(...propNames) {
    let props = {};
    for (let propName of propNames) {
      if (!ALLOWED_PROPS_IN_LIST_CONTROLLER.has(propName)) continue;
      props[propName] = null;
    }
    return this.list.update(props);
  }
}

module.exports = ListController;
