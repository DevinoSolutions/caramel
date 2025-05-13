#!/bin/bash
set -e

# Updating the Xcode project with custom icons
# Should be run after safari-web-extension-converter has generated the project

# Arguments
PROJECT_DIR=${1:-"SafariExtProject/App"}
ICONS_DIR=${2:-"safari-icons"}

echo "Updating Safari app icons in $PROJECT_DIR with icons from $ICONS_DIR"

# Find all .xcassets directories that might contain AppIcon.appiconset
find "$PROJECT_DIR" -name "*.xcassets" -type d | while read -r assets_dir; do
  APPICONSET_DIR="$assets_dir/AppIcon.appiconset"

  if [ -d "$APPICONSET_DIR" ]; then
    echo "Found app icon set at $APPICONSET_DIR"

    # Read the Contents.json to find all icon files and their sizes
    CONTENTS_FILE="$APPICONSET_DIR/Contents.json"

    if [ -f "$CONTENTS_FILE" ]; then
      # For each icon entry in Contents.json
      jq -c '.images[]' "$CONTENTS_FILE" | while read -r icon_entry; do
        # Extract filename and size
        FILENAME=$(echo "$icon_entry" | jq -r '.filename // empty')
        SIZE=$(echo "$icon_entry" | jq -r '.size // empty')
        SCALE=$(echo "$icon_entry" | jq -r '.scale // "1x"')

        if [ -n "$FILENAME" ] && [ -n "$SIZE" ]; then
          # Parse size like "29x29" to get dimension
          WIDTH=$(echo "$SIZE" | cut -d'x' -f1)

          # Extract scale multiplier (2x -> 2, 3x -> 3)
          SCALE_FACTOR=$(echo "$SCALE" | sed 's/x$//')

          # Calculate actual size
          ACTUAL_SIZE=$((WIDTH * SCALE_FACTOR))

          # Find matching icon from our generated set
          SOURCE_ICON="$ICONS_DIR/icon_${ACTUAL_SIZE}x${ACTUAL_SIZE}.png"

          if [ -f "$SOURCE_ICON" ]; then
            echo "Replacing $FILENAME with custom icon ($ACTUAL_SIZE×$ACTUAL_SIZE)"
            cp "$SOURCE_ICON" "$APPICONSET_DIR/$FILENAME"
          else
            # If we don't have an exact match, find the closest larger size and resize
            LARGER_ICON=$(find "$ICONS_DIR" -name "icon_*x*.png" | sort -V | while read -r icon; do
              ICON_SIZE=$(basename "$icon" | sed -E 's/icon_([0-9]+)x.*/\1/')
              if [ "$ICON_SIZE" -ge "$ACTUAL_SIZE" ]; then
                echo "$icon"
                break
              fi
            done)

            if [ -n "$LARGER_ICON" ]; then
              echo "Resizing from larger icon to $ACTUAL_SIZE×$ACTUAL_SIZE for $FILENAME"
              convert "$LARGER_ICON" -resize "${ACTUAL_SIZE}x${ACTUAL_SIZE}" "$APPICONSET_DIR/$FILENAME"
            else
              echo "Warning: No suitable icon found for $FILENAME ($ACTUAL_SIZE×$ACTUAL_SIZE)"
            fi
          fi
        fi
      done
    else
      echo "Warning: No Contents.json found in $APPICONSET_DIR"
    fi
  fi
done

echo "Safari app icons updated successfully"