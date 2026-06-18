import { InMemoryRunner, toStructuredEvents, Gemini } from '@google/adk';
import { worldRadioAgent, CustomGroqLlm } from './agent.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function runTest() {
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;

  if (groqKey) {
    worldRadioAgent.model = new CustomGroqLlm({
      model: 'llama-3.3-70b-versatile',
      apiKey: groqKey,
    });
  } else if (geminiKey) {
    worldRadioAgent.model = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: geminiKey,
    });
  }

  const query = process.argv[2] || 'Find jazz radio stations in Paris';
  console.log(`===================================================`);
  console.log(`Testing World Radio Agent with query: "${query}"`);
  console.log(`===================================================`);

  const runner = new InMemoryRunner({
    agent: worldRadioAgent,
    appName: 'TestWorldRadio',
  });

  try {
    const eventGenerator = runner.runEphemeral({
      userId: 'test-user',
      newMessage: {
        role: 'user',
        parts: [{ text: query }],
      },
    });

    for await (const rawEvent of eventGenerator) {
      const author = rawEvent.author || 'system';
      const structuredEvents = toStructuredEvents(rawEvent);

      for (const ev of structuredEvents) {
        if (ev.type === 'content') {
          process.stdout.write(ev.content);
        } else if (ev.type === 'thought') {
          console.log(`\n\n[Thought - ${author}] ${ev.content}`);
        } else if (ev.type === 'tool_call') {
          console.log(`\n\n[Tool Call - ${author}] ${ev.call.name}(${JSON.stringify(ev.call.args)})`);
        } else if (ev.type === 'tool_result') {
          const responseVal = ev.result.response;
          const resStr = (typeof responseVal === 'object' ? JSON.stringify(responseVal) : String(responseVal)) || '';
          console.log(`\n[Tool Result - ${author}] ${ev.result.name} -> ${resStr.substring(0, 150)}...`);
        } else if (ev.type === 'error') {
          console.error(`\n[Error] ${ev.error.message}`);
        }
      }
    }
    console.log('\n\n===================================================');
    console.log('Test execution completed successfully.');
    console.log('===================================================');
  } catch (err: any) {
    console.error('\n\nTest execution failed:', err.message);
  }
}

runTest();
