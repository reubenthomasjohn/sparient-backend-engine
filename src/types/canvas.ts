export interface CanvasCourse {
  id: number;
  name: string;
  course_code: string;
  enrollment_term_id: number;
  workflow_state: string;
}

export interface CanvasTerm {
  id: number;
  name: string;
  start_at: string | null;
  end_at: string | null;
  workflow_state: string;
}

export interface CanvasFolder {
  id: number;
  name: string;
  full_name: string;
  parent_folder_id: number | null;
  // "Course" for course files, "User"/"Group" for others. The replacer only handles "Course".
  context_type: string;
  context_id: number;
}

export interface CanvasFile {
  id: number;
  uuid: string;
  folder_id: number;
  display_name: string;
  filename: string;
  'content-type': string;
  url: string;
  size: number;
  created_at: string;
  updated_at: string;
  modified_at: string;
  locked: boolean;
  hidden: boolean;
}
