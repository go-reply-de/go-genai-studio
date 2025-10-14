#!/bin/bash

# Prompt the user for the filename
read -p "Enter the service account name to be created [sa-genai-studio-jdoe]: " filename

# Check if the user entered anything
if [ -z "$filename" ]; then
  echo "No filename provided."
  exit 1
fi

# Now you can use the $filename variable in your script
echo "You entered: $filename"

# Set variables in command line
PROJECT_ID="go-de-genai-demo"  # GCP project ID
SERVICE_ACCOUNT_NAME=$filename  # Name of the service account
KEY_FILE="$filename.json" # Name of the key to be created in the service account including the format

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
  echo "gcloud CLI not found. Please install it: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Authenticate to your GCP account (if not already authenticated)
gcloud auth login

# Logged in succesfully?
printf "%s " "Are you logged in successfully? - press ENTER"
read ans

# Set your active project
gcloud config set project "$PROJECT_ID"

# Create the service account
gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
  --display-name "$SERVICE_ACCOUNT_NAME"

echo "Service account $filename created."

# Prompt the user for the setting expiry date of the policies to be attached to the SA
read -p "Do you want to set expiration date for the policies to be attached to this $filename service account? [yes/no]" expiration_date_input

# Check if the user entered anything
if [ -z "$expiration_date_input" ]; then
  echo "No policies will be attached to this $filename SA. Script exiting without key generation."
  exit 1
fi

if [[ "$expiration_date_input" == "yes" ]]; then
  echo "You entered: $expiration_date_input"

  while true; do
    read -p "Enter the number of months: " months
    if [[ -n "$months" && "$months" =~ ^[0-9]+$ ]]; then  # Check if input is non-empty and only contains digits
      echo "You entered $months months."

      # Calculate the expiry date (3 months from today)
      EXPIRY_DATE=$(date -v +${months}m +%Y-%m-%dT%H:%M:%SZ)

      # Construct the condition components
      CONDITION_TITLE="expire-after-$months-months"
      CONDITION_DESCRIPTION="This condition expires the binding after $months months."
      CONDITION_EXPRESSION="request.time < timestamp(\"$EXPIRY_DATE\")"

      # Add Vertex AI User role to the service account
      gcloud projects add-iam-policy-binding $PROJECT_ID \
        --member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
        --role="roles/aiplatform.user" \
        --condition=title="$CONDITION_TITLE",description="$CONDITION_DESCRIPTION",expression="$CONDITION_EXPRESSION"

      # Add Discovery Engine Viewer role to the service account
      gcloud projects add-iam-policy-binding $PROJECT_ID \
        --member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
        --role="roles/discoveryengine.viewer" \
        --condition=title="$CONDITION_TITLE",description="$CONDITION_DESCRIPTION",expression="$CONDITION_EXPRESSION"
      break
    else
      echo "Invalid input. Please enter a valid number of months."
    fi
  done
elif [[ "$expiration_date_input" == "no" ]]; then
  echo "You entered: $expiration_date_input"
  echo "No expiry will be set."

  # Add Vertex AI User role to the service account
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/aiplatform.user" \
    --condition=None

  # Add Discovery Engine Viewer role to the service account
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/discoveryengine.viewer" \
    --condition=None
else
  echo "Invalid input. Expiration date will be valid for 3 months from today"
  # Calculate the expiry date (3 months from today)
  EXPIRY_DATE=$(date -v +3m +%Y-%m-%dT%H:%M:%SZ)

  # Construct the condition components
  CONDITION_TITLE="expire_after_3_months"
  CONDITION_DESCRIPTION="This condition expires the binding after 3 months."
  CONDITION_EXPRESSION="request.time < timestamp(\"$EXPIRY_DATE\")"

  # Add Vertex AI User role to the service account
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/aiplatform.user" \
    --condition=title="$CONDITION_TITLE",description="$CONDITION_DESCRIPTION",expression="$CONDITION_EXPRESSION"

  # Add Discovery Engine Viewer role to the service account
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/discoveryengine.viewer" \
    --condition=title="$CONDITION_TITLE",description="$CONDITION_DESCRIPTION",expression="$CONDITION_EXPRESSION"
fi

# Create the key file
gcloud iam service-accounts keys create "$KEY_FILE" \
  --iam-account="$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com"

echo "Service account '$SERVICE_ACCOUNT_NAME' created with key file '$KEY_FILE'."
