litert-js
    - XNNPACK - CPU - WASM
    - ML Drift - GPU - WebGPU (native & web)
    - Emerging - NPU - WebNN 

litert-js core
    - litert-lm - agentic
    - mediaPipe - prompting

litert-js core runs .tflite and are supposed to run ml models.

litert-lm runs .litertlm and contains the tokenizers, KV caching and the memory management 

litert-lm and mediaPipe runs .litertlm
    - litert-lm supports dynamic vision and audio encodings
    - mediaPipe needs then during instatiation

.litertlm has -Web models that has a magic number and can be run only by modelPipe since they are modelpipe streaming packages












NORMAL WORK FLOW


tokenizers - backend - text tokenizers
patchers - backend - visual/audio patches

embedders - backend - token to vector
encoders - backend - patches to vector

------------------------------------------------------------------

decoders - llm - vector input to vector output
output head - llm - vector to token for text and vector to embeddings for image/audio

------------------------------------------------------------------

de-tokenizer - backend - token to text
VAE Decoder - backend - embedding to image/audio






LITERT-LM WORKFLOW


Client Input: User provides Text + Image.

Client Process (LiteRT-LM):

Text -> Tokenizer -> IDs -> Embedder -> Vector

Image -> Patcher -> Raw Pixels -> Linear Projection (No complex Encoder) -> Vector

Hardware Execution (WebGPU / NPU): All vectors are concatenated and fed directly into the Decoder (The LLM).

Output Head: Decoder spits out the final vector -> Output Head selects the most probable Text Token ID.

Client Process (LiteRT-LM): Token ID -> Detokenizer -> Text string -> Streamed to your UI.







Initialize the Engine: You load the .litertlm file into the Engine. The Engine owns the memory and the connection to the hardware (like WebGPU).

Create a Conversation: You ask the Engine to create a Conversation object. You can pass system prompts here (e.g., "You are a coding assistant").

SendMessageStreaming: You send your prompt to the Conversation. The engine streams the response back.  

(KV Caching): When you send a second prompt, LiteRT-LM does not re-read the first prompt. It has already cached the mathematical state (the KV Cache) of the previous turns. It only processes the new text.

Lifecycle Management: Because the Engine holds massive memory allocations on the GPU, you must explicitly call conversation.delete() and engine.delete() when the user closes the chat to prevent memory leaks.










Model Pipe Work Flow





Client Input: User provides Text.

Client Process (MediaPipe Task Call):You call a single function (e.g., textEmbedder.embed(text)). From this point, MediaPipe handles the entire pipeline internally.

Internal Pipeline (Within the .task execution):Text -> Tokenizer (In-graph/Out-of-graph) -> IDs: MediaPipe uses the tokenizer bundled in the .task file's metadata to convert the string.IDs -> Model Inference (WebAssembly / GPU) -> Output Tensor: The IDs are passed directly to the hardware backend.

Output Generation:The model executes and returns the final mathematical tensor (the raw Float32 values).

Client Process (MediaPipe Formatting):MediaPipe packages that raw tensor into a structured EmbeddingResult object. It can optionally apply post-processing, like L2 normalization or scalar quantization.  

Final Delivery: The EmbeddingResult vector is returned to your application.








Input: You give the API a single text prompt.

Process: The API tokenizes the prompt, runs the .task file (which bundles the .tflite model and metadata), and streams the output back.

Output: It returns the text and instantly forgets everything that just happened.






for litert core, the graphs mean, signatures.. text, image, audio signatures.. when the signatures are met, the assocaited encoder is loaded.. native apis use posix mmap method to store the encoder buffer arrays in the ssd, and load only when required