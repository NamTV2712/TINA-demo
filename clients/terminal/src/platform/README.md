# platform

The client substrate: dependency injection (`createServiceId`/`useService`), observable `createStore`/`useStore`, and the `Command`/`ContextKey` services. Views consume injected services and stores — never reaching across surfaces (VSCode-style DI + service layer).

The window keybinding capture listener yields Escape originating inside an open native dialog.
The dialog closes first without invoking workbench Back; normal navigation resumes after it
closes. The meeting-dialog integration tests exercise this ordering using the real keybinding
and command services, registered before the dialog opens.
