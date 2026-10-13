#!/usr/bin/env python3
"""Read a Pages deployment baseline without emitting credentials or env values."""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request


def deployment_summary(deployment):
    metadata = (deployment.get("deployment_trigger") or {}).get("metadata") or {}
    return {
        "id": deployment.get("id"),
        "environment": deployment.get("environment"),
        "created_on": deployment.get("created_on"),
        "url": deployment.get("url"),
        "commit_hash": metadata.get("commit_hash"),
        "branch": metadata.get("branch"),
        "status": (deployment.get("latest_stage") or {}).get("status"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="todayjpop")
    args = parser.parse_args()
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        raise ValueError("CLOUDFLARE_ACCOUNT_ID must contain a 32-character account identifier")
    if not token:
        raise ValueError("CLOUDFLARE_API_TOKEN is absent")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", args.project):
        raise ValueError("Invalid Pages project name")
    base = "https://api.cloudflare.com/client/v4/accounts/" + account + "/pages/projects/" + args.project

    def get(suffix):
        request = urllib.request.Request(base + suffix, headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
        try:
            # The inherited proxy and CA configuration remain in use.
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            try:
                payload = json.load(error)
            except (ValueError, OSError):
                payload = {}
            codes = [item.get("code") for item in payload.get("errors", [])]
            raise RuntimeError("Cloudflare HTTP " + str(error.code) + "; error codes " + str(codes)) from None
        if not payload.get("success"):
            raise RuntimeError("Cloudflare request unsuccessful")
        return payload["result"]

    project = get("")
    deployments = get("/deployments?env=production&per_page=10")
    domains = get("/domains")
    source = (project.get("source") or {}).get("config") or {}
    build = project.get("build_config") or {}
    result = {
        "name": project["name"],
        "id": project["id"],
        "domains": [{"name": domain.get("name"), "status": domain.get("status")} for domain in domains],
        "source": {key: source.get(key) for key in ["owner", "repo_name", "production_branch"]},
        "build": {key: build.get(key) for key in ["build_command", "destination_dir", "root_dir"]},
        "canonical_deployment": deployment_summary(project["canonical_deployment"]),
        "recent_deployments": [deployment_summary(deployment) for deployment in deployments],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error)
        for name in ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]:
            value = os.environ.get(name)
            if value:
                message = message.replace(value, "[redacted]")
        print("Cannot inspect Cloudflare: " + message, file=sys.stderr)
        sys.exit(1)
