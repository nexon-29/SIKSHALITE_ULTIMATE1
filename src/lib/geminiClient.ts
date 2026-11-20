import { QuizQuestion } from '../types/sikshalite';

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Unexpected response from server (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error((data.error as string) || `Request failed (${response.status})`);
  }
  return data as T;
}

export async function generateQuizWithGemini(params: {
  subjectName: string;
  topicTitle: string;
  topicDescription?: string;
  quizType: 'pre' | 'post';
  questionCount?: number;
  referenceContext?: string;
}): Promise<QuizQuestion[]> {
  const res = await postJson<{ questions: QuizQuestion[] }>('/api/gemini/generate-quiz', params);
  return res.questions ?? [];
}

export async function generateStudyMaterialWithGemini(params: {
  subjectName: string;
  topicTitle: string;
  topicDescription?: string;
  gradeLevel?: string;
}): Promise<{ studyContent: string }> {
  return postJson<{ studyContent: string }>('/api/gemini/generate-material', params);
}

export async function generateAssignmentWithGemini(params: {
  subjectName: string;
  topicTitle: string;
  topicDescription?: string;
  assignmentMode: 'written' | 'file' | 'both';
}): Promise<{ assignmentPrompt: string }> {
  return postJson<{ assignmentPrompt: string }>('/api/gemini/generate-assignment', params);
}

export async function generateReferenceDiagramWithGemini(params: {
  subjectName: string;
  topicTitle: string;
  topicDescription?: string;
  studyContext?: string;
  visualPrompt?: string;
}): Promise<{ caption: string; svg: string }> {
  return postJson<{ caption: string; svg: string }>('/api/gemini/generate-diagram', params);
}
