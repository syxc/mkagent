/** The current host advertises hasUI=false; native modes can supply a real UI. */
export const theme = new Proxy({}, {
  get() {
    throw new Error('Pi terminal rendering needs a TUI host. Check ctx.hasUI before rendering.');
  },
});
