import argparse
import json
import re
import sys

def parse_required_fields(fields_file):
    with open(fields_file, "r", encoding="utf-8") as f:
        text = f.read()
    return re.findall(r"^\s*-\s*name:\s*([A-Za-z0-9_]+)", text, flags=re.MULTILINE)

def validate(fields_file, json_file):
    required = parse_required_fields(fields_file)
    with open(json_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    missing = [k for k in required if k not in data or data[k] in (None, "", [])]
    if "uncertain" not in data or not isinstance(data["uncertain"], list):
        missing.append("uncertain (array)")

    marked_fields = []
    for k in required:
        val = data.get(k)
        if isinstance(val, str) and "[uncertain]" in val:
            marked_fields.append(k)
        elif isinstance(val, list) and any(isinstance(x, str) and "[uncertain]" in x for x in val):
            marked_fields.append(k)

    if set(marked_fields) != set(data.get("uncertain", [])):
        print(f"FAIL: Mismatch between [uncertain] markers {marked_fields} and uncertain array {data.get('uncertain')}", file=sys.stderr)
        return False

    if missing:
        print(f"FAIL: {json_file} missing fields: {missing}", file=sys.stderr)
        return False

    print(f"PASS: {json_file} ({len(required)}/{len(required)} required fields validated; uncertain={data['uncertain']})")
    return True

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-f", "--fields", required=True)
    parser.add_argument("-j", "--json", required=True)
    args = parser.parse_args()
    if not validate(args.fields, args.json):
        sys.exit(1)
