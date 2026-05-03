// Canvas IDs are integers but Enterprise tenants assign 18+-digit values that
// exceed JS Number.MAX_SAFE_INTEGER. Plain JSON.parse silently mangles those
// IDs; the CanvasClient is configured with json-bigint to parse them as
// strings, so we type every id field as string here. Code that compares or
// stores them stays correct regardless of magnitude.

export interface CanvasCourse {
  id: string;
  name: string;
  course_code: string;
  enrollment_term_id: string;
  workflow_state: string;
}

export interface CanvasTerm {
  id: string;
  name: string;
  start_at: string | null;
  end_at: string | null;
  workflow_state: string;
}

export interface CanvasFolder {
  id: string;
  name: string;
  full_name: string;
  parent_folder_id: string | null;
  // "Course" for course files, "User"/"Group" for others. The replacer only handles "Course".
  context_type: string;
  context_id: string;
}

export interface CanvasFile {
  id: string;
  uuid: string;
  folder_id: string;
  display_name: string;
  filename: string;
  'content-type': string;
  url: string;
  // Canvas reports size as an integer; json-bigint with storeAsString returns
  // it as a string. Use Number(f.size) at any arithmetic site (with a NaN
  // guard if the field is missing). Practical sizes won't exceed
  // Number.MAX_SAFE_INTEGER (~9 PB), so post-coercion arithmetic is safe.
  size: string;
  created_at: string;
  updated_at: string;
  modified_at: string;
  locked: boolean;
  hidden: boolean;
}
