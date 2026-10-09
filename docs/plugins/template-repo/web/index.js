// Example: the web part. keel loads this ES module at start and calls setup() once.
// Build a bigger web part with Vite as an ES library; react and @keel/web-sdk come from keel's page.

export default {
  name: "example",
  setup(sdk) {
    // sdk.registerPage({ id: "example", label: "Example", group: "project", order: 90, component: MyPage });
  },
};
