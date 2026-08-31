// Cross-platform HPKE seal/open fixture.
import CryptoKit
import Foundation

struct Cross: Decodable { let skRm: String; let pkRm: String; let enc: String; let ct: String; let ptSha256: String }
struct Fx: Decodable { let transcriptBytesHex: String }

func hex(_ s: String) -> Data {
  var d = Data(); var i = s.startIndex
  while i < s.endIndex { let n = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<n], radix: 16)!); i = n }
  return d
}
func b64url(_ d: Data) -> String {
  d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

let cross = try JSONDecoder().decode(Cross.self, from: try Data(contentsOf: URL(fileURLWithPath: "cross.json")))
let fx = try JSONDecoder().decode(Fx.self, from: try Data(contentsOf: URL(fileURLWithPath: "../fixtures.json")))
let suite = HPKE.Ciphersuite(kem: .Curve25519_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_256)
let info = Data("qm-grant-v1".utf8)
let aad = Data(SHA256.hash(data: hex(fx.transcriptBytesHex))) // derived independently, never read
let sk = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(cross.skRm))

var recipient = try HPKE.Recipient(privateKey: sk, ciphersuite: suite, info: info, encapsulatedKey: hex(cross.enc))
let pt = try recipient.open(hex(cross.ct), authenticating: aad)
let plaintextHashOk = Data(SHA256.hash(data: pt)).map { String(format: "%02x", $0) }.joined() == cross.ptSha256

var wrongAadRejected = false
do {
  var r2 = try HPKE.Recipient(privateKey: sk, ciphersuite: suite, info: info, encapsulatedKey: hex(cross.enc))
  _ = try r2.open(hex(cross.ct), authenticating: Data(repeating: 9, count: 32))
} catch { wrongAadRejected = true }
var wrongKeyRejected = false
do {
  var r3 = try HPKE.Recipient(privateKey: Curve25519.KeyAgreement.PrivateKey(), ciphersuite: suite, info: info, encapsulatedKey: hex(cross.enc))
  _ = try r3.open(hex(cross.ct), authenticating: aad)
} catch { wrongKeyRejected = true }

// Apple seals back to Node's public key, same plaintext, same derived AAD.
let pk = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: hex(cross.pkRm))
var sender = try HPKE.Sender(recipientKey: pk, ciphersuite: suite, info: info)
let ct2 = try sender.seal(pt, authenticating: aad)
let envelope = "{\"v\":1,\"kem\":32,\"kdf\":1,\"aead\":2,\"enc\":\"\(b64url(sender.encapsulatedKey))\",\"ct\":\"\(b64url(ct2))\"}"
try Data(envelope.utf8).write(to: URL(fileURLWithPath: "apple-sealed.json"))

print("{\"opened\": \(pt.count), \"plaintextHashOk\": \(plaintextHashOk), \"aadDerivedFromTranscript\": true, \"wrongAadRejected\": \(wrongAadRejected), \"wrongKeyRejected\": \(wrongKeyRejected), \"appleSealedWritten\": true}")
