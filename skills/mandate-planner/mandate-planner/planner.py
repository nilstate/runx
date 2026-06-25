import json
import sys

def validate(proposed, grant):
    # Validate roles
    proposed_roles = [r['role'] for r in proposed['candidate_roster']]
    for role in proposed_roles:
        if role not in grant['granted_roles']:
            return {"eligible": False, "reason": f"Role {role} not granted"}
    
    # Validate limits
    if proposed['requested_limits']['spend'] > grant['granted_spend']:
        return {"eligible": False, "reason": "Spend exceeds grant"}
    
    if proposed['requested_limits']['max_turns'] > grant['max_turns']:
        return {"eligible": False, "reason": "Turns exceed grant"}
    
    if not proposed.get('done_check'):
        return {"eligible": False, "reason": "Missing done_check"}
        
    return {"eligible": True, "reason": "Valid", "recommended_charter": proposed}

if __name__ == "__main__":
    input_data = json.load(sys.stdin)
    result = validate(input_data['proposed_charter'], input_data['authority_grant'])
    print(json.dumps(result))
