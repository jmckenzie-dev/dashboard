#!/bin/bash

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ai-dashboard"
CERT_FILE="$CONFIG_DIR/cert.pem"
KEY_FILE="$CONFIG_DIR/key.pem"

mkdir -p "$CONFIG_DIR"

if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  echo "Certificates already exist at:"
  echo "  Cert: $CERT_FILE"
  echo "  Key:  $KEY_FILE"
  exit 0
fi

echo "Generating self-signed certificate..."

openssl req -x509 -newkey rsa:4096 -keyout "$KEY_FILE" -out "$CERT_FILE" \
  -days 365 -nodes \
  -subj "/C=US/ST=Local/L=Local/O=AI Dashboard/OU=Self-Signed/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0" \
  2>/dev/null

if [ $? -eq 0 ]; then
  chmod 600 "$KEY_FILE"
  chmod 644 "$CERT_FILE"
  echo "Certificates generated successfully!"
  echo "  Cert: $CERT_FILE"
  echo "  Key:  $KEY_FILE"
  echo ""
  echo "Note: You may need to accept the self-signed certificate in your browser."
else
  echo "Failed to generate certificates"
  exit 1
fi
