# Frontend

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.29.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

The development server proxies `/api`, `/ws`, and `/health` to `http://localhost:3000` (see `proxy.conf.json`) so browser requests are same-origin during local development. Production uses same-origin paths by default; configure the production reverse proxy to route these paths to the backend.

If the frontend and backend use different origins, the backend must allow the exact frontend origin, the API methods in use (`GET`, `POST`, `PUT`, `DELETE`, and `OPTIONS`), and the `Authorization`, `Content-Type`, and `Idempotency-Key` request headers. Expose `Retry-After` to the browser if cross-origin clients need to honor rate limits. WebSocket connections also need an origin/authentication policy; browser `WebSocket` and `EventSource` clients cannot set an `Authorization` header, so their authentication mechanism must be supported by the backend.

The frontend uses the existing `/api/services/snapshot` endpoint for full snapshot recovery and the WebSocket `replay-request` message with a `since` offset for event replay. The backend WebSocket sends metric events in batches; the top-level offset is the last event offset in that batch.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
