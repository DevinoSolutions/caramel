# Caramel

Caramel is your trusted, open-source companion for saving on online purchases. No scams, just sweet deals!

## Browser Extension

The browser extension is located in the `caramel-extension` directory. It supports:

- Chrome/Edge (Chromium-based browsers)
- Safari (macOS & iOS)

### Safari Extension Icons

The Safari Web Extension Converter (`xcrun safari-web-extension-converter`) automatically converts Chrome extension icons to Safari app icons, but it often adds white padding around the icons. To solve this issue, we've created custom scripts that generate properly formatted Safari app icons from a single source icon:

- `caramel-extension/scripts/generate-safari-icons.sh`: Generates properly formatted icons for Safari
- `caramel-extension/scripts/update-safari-icons.sh`: Updates the Xcode project with custom icons

These scripts are integrated into the CI workflow (`.github/workflows/release.yml`) to automatically generate and update Safari icons during the build process.

To test the icon generation process locally:

```bash
cd caramel-extension/scripts
./test-safari-icons.sh
```

See `caramel-extension/scripts/README.md` for more details.

## CI/CD

The project uses GitHub Actions for CI/CD. The workflow is defined in `.github/workflows/release.yml`.

## License

See [LICENSE](LICENSE) file for details.