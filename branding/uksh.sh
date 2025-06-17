set -e
echo "Applying UKSH branding..."

FILE_NAV="client/src/components/Nav/Nav.tsx"
FILE_AUTH="client/src/components/Auth/AuthLayout.tsx"
FILE_HTML="client/index.html"
OLD_LOGO_PATH_HTML="/assets/favicon-runningman.png"
OLD_LOGO_PATH="/assets/Go Reply - LOGO RGB.png"
NEW_LOGO_PATH="/assets/uksh/Logo_UKSH.png"

## Check if the files exist before attempting to modify
if [ -f "$FILE_NAV" ] && [ -f "$FILE_AUTH" ] && [ -f "$FILE_HTML" ]; then
  sed -i '' "s|${OLD_LOGO_PATH}|${NEW_LOGO_PATH}|g" "$FILE_NAV"
  sed -i '' "s|${OLD_LOGO_PATH}|${NEW_LOGO_PATH}|g" "$FILE_AUTH"
  sed -i '' "s|${OLD_LOGO_PATH_HTML}|${NEW_LOGO_PATH}|g" "$FILE_HTML"
  echo "Logo branding applied successfully to both files."
else
  echo "Error: One or both branding target files not found."
  exit 1
fi

echo "Logos were changed successfully."