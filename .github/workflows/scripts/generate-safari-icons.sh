#!/bin/bash
set -e

# Generating properly formatted icons for Safari from a single source icon
# Requires ImageMagick to be installed

# Check if ImageMagick is installed
if ! command -v convert &> /dev/null; then
    echo "Error: ImageMagick is not installed. Please install it with 'brew install imagemagick'"
    exit 1
fi

# Source icon path (should be at least 1024x1024)
SOURCE_ICON=${1:-"icons/original.png"}

# Output directory
OUTPUT_DIR="safari-icons"
mkdir -p "$OUTPUT_DIR"

# Generate icons with proper rounding for macOS/iOS
# These sizes are required for Apple App Store
ICON_SIZES=(16 20 29 32 40 58 60 64 76 80 87 120 128 152 167 180 256 512 1024)

echo "Generating Safari icons from $SOURCE_ICON"

for size in "${ICON_SIZES[@]}"; do
  echo "Creating $size×$size icon..."

  # Create a rounded square icon with proper corner radius (following Apple's guidelines)
  # The corner radius is approximately 23% of the icon size for iOS/macOS app icons
  radius=$(echo "$size * 0.23" | bc)

  convert "$SOURCE_ICON" \
    -resize ${size}x${size} \
    \( +clone -alpha extract \
      -draw "roundrectangle 0,0,$size,$size,$radius,$radius" \
      -alpha on \
    \) -compose CopyOpacity -composite \
    "$OUTPUT_DIR/icon_${size}x${size}.png"
done

echo "Safari icons generated in $OUTPUT_DIR"