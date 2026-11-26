"""Per-track label sets. Data sales and M&A are separate: each has its own caller moves, owner objections and
call sections. The labeling pass, the path store, the move classifier and the grader all read from here."""

SHARED_CALLER = ["greet", "name_check", "how_are_you", "intro_self", "ask_for_owner", "answer_who", "ask_question",
                 "objection_response", "ask_meeting", "callback_offer", "get_contact", "confirm_details", "wrap_up",
                 "voicemail", "small_talk", "filler", "other"]

CALLER = {
    "data": SHARED_CALLER + ["weird_request", "research_reason", "why_you", "pay_offer", "record_examples",
                             "explain_use", "privacy_answer", "price_answer", "arieh_intro"],
    "ma": SHARED_CALLER + ["buyer_intro", "buyer_profile", "ask_selling", "timing_answer", "privacy_answer",
                           "valuation_deflect", "how_found_answer", "process_explain", "fit_question"],
}

OBJECTIONS = {
    "data": ["what_is_this", "who_are_you", "scam_or_trust", "confidentiality", "price_or_value", "send_email",
             "not_decision_maker", "no_records", "not_interested", "busy", "partner_decides", "other"],
    "ma": ["not_selling", "timing", "who_is_buyer", "pe_worry", "valuation_ask", "confidentiality", "how_got_number",
           "already_approached", "family_succession", "partner_decides", "send_email", "not_interested", "busy", "other"],
}

OWNER_ACTS = ["greeting", "confirm_identity", "screen", "not_available", "transfer", "take_message", "guarded_question",
              "curious_question", "objection", "brush_off", "engaged", "agree_next_step", "give_contact", "ack",
              "ending", "hang_up", "other"]

# Sections of a call, in order, with the caller moves that belong to each.
SECTIONS = {
    "data": {"opener": {"greet", "name_check", "how_are_you", "intro_self", "weird_request", "research_reason", "why_you",
                        "pay_offer", "ask_for_owner", "answer_who"},
             "explain": {"record_examples", "explain_use", "price_answer", "ask_question", "arieh_intro"},
             "objections": {"objection_response", "privacy_answer"},
             "close": {"ask_meeting", "callback_offer", "get_contact", "confirm_details", "wrap_up"}},
    "ma": {"opener": {"greet", "name_check", "how_are_you", "intro_self", "buyer_intro", "buyer_profile", "ask_selling",
                      "ask_for_owner", "answer_who"},
           "explain": {"process_explain", "fit_question", "ask_question"},
           "objections": {"objection_response", "timing_answer", "privacy_answer", "valuation_deflect", "how_found_answer"},
           "close": {"ask_meeting", "callback_offer", "get_contact", "confirm_details", "wrap_up"}},
}

# Owner reactions that read as the caller's last move landing (+) or not (-).
REACTION_VALUE = {"engaged": 2, "curious_question": 1.5, "agree_next_step": 3, "give_contact": 1.5, "confirm_identity": .5,
                  "transfer": 1, "take_message": .5, "ack": .3, "greeting": 0, "screen": -.3, "not_available": 0,
                  "guarded_question": -.5, "objection": -1, "brush_off": -2, "ending": -1, "hang_up": -3, "other": 0}

# Outcome of the call read from the transcript, best first, 0..10.
OUTCOMES = {"meeting_booked": 10, "callback_interested": 8, "callback_set": 5, "info_or_email": 4, "message_left_with_person": 3,
            "soft_no": 2, "hard_no": 0, "hung_up": 0, "voicemail": None, "no_conversation": None}


def section_of(track, move):
    for s, moves in SECTIONS.get(track, SECTIONS["data"]).items():
        if move in moves: return s
    return None


def section_of_any(move):
    for tr in SECTIONS:
        s = section_of(tr, move)
        if s: return s
    return None


import re as _re
_DATA = _re.compile(r"working signal|weird request|records?\b|pay (you|your|to access|for)|licens|\bdata\b|\bai\b|artificial|"
                    r"anthropic|openai|training|project (files|records)|archive", _re.I)
_MA = _re.compile(r"acquir|acquisition|buyer|buy (your|the) (business|company)|sell(ing)? (your|the) (business|company)|"
                  r"thought about selling|succession|individual operator|not a fund|valuation", _re.I)


def pitch_track(intern_text, fallback=None):
    """What the caller actually pitched, from their own words. Lists mix pitches, so the list alone misfiles calls."""
    d, m = len(_DATA.findall(intern_text or "")), len(_MA.findall(intern_text or ""))
    if d >= 2 and d > 1.5 * m: return "data"
    if m >= 1 and m > 1.5 * d: return "ma"
    return fallback
