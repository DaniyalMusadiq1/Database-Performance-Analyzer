# Publish your extension

The local VSIX works without Marketplace registration. Publishing needs your own Microsoft account and publisher membership; the configured publisher ID is `DaniyalMusadiq`, and local authentication is required.

1. Create an identity at [Marketplace publisher management](https://marketplace.visualstudio.com/manage). Choose your unique publisher ID.
2. Confirm that `DaniyalMusadiq` is the registered publisher ID for your account. The manifest links the project repository and issue tracker on GitHub.
3. Complete the database/platform validation in `VALIDATION.md`; review `SECURITY.md` and dependency advisories. Version the release and update `CHANGELOG.md`.
4. Run `npm ci`, `npm run verify`, `npm run test:integration`, `npm run test:host` and `npm run package`. Review the files with `npx vsce ls --no-dependencies`.
5. Install the VSIX in a fresh VS Code profile and test your real databases with a least-privilege account.
6. Authenticate locally and publish, or upload the generated VSIX from the publisher management page.

Use [Microsoft's current publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension). They recommend Microsoft Entra ID with workload identity federation / managed identity. A configured Azure identity can publish with:

```sh
npm run publish:marketplace -- --azure-credential
```

PAT authentication is also currently documented: use `npx vsce login DaniyalMusadiq`, enter the token in the local terminal, then `npm run publish:marketplace`. Do not paste tokens in chat, source files or workflow YAML. Microsoft documents retirement of global Azure DevOps PATs on **December 1, 2026**, so prefer the identity-based workflow for ongoing publishing.

The publish script refuses the placeholder publisher. It cannot create a Microsoft account or grant publisher membership. Marketplace publication is public and subject to Microsoft's validation.
