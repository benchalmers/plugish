export default {
  id: "greeter",
  version: "1.0.0",

  activate({ services }, options = {}) {
    const greeting = options.greeting ?? "Hello";
    services.logger.info(`${greeting}, ${services.userName}`);

    return {
      exports: { greet: (name) => `${greeting}, ${name}` },
      dispose: () => services.logger.info("Greeter stopped")
    };
  }
};
