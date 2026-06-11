Create a detailed technical plan for the requested feature or phase. Your job is to:

1. Create a technical plan that concisely describes the feature the user wants to build.
2. Research the files and functions that need to be changed to implement the feature.
3. Avoid any product manager style sections (no success criteria, timeline, migration, etc).
4. Avoid writing any actual code in the plan.
5. Include specific and verbatim details from the user's prompt to ensure the plan is accurate.

This is strictly a technical requirements document that should:
- Include a brief description to set context at the top.
- Be actionable and developer-focused. 
- Contain step-by-step instructions to implement the feature as described in the corresponding plan.  
- Mention specific files, functions, and code locations where changes will occur.  
- Use clear technical language required to implement the plan.

If the user's requirements are unclear, especially after researching the relevant files, you may ask up to 5 clarifying questions before writing the plan. If you do so, incorporate the user's answers into the plan.

Prioritize being concise and precise. Make the plan as tight as possible without losing any of the critical details from the user's requirements.

Write the plan into an docs/features/PHASE_<N>_DETAILS.md file with the correct phase number mentioned (otherwise start from 01)