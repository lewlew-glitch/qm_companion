// Swift verification for shared transcript, SAS and signature fixtures.
import CryptoKit
import Foundation

struct Fx: Decodable {
  let publicKey: String
  let transcriptBytesHex: String, transcriptHashHex: String, transcriptSignature: String
  let sasDigits: [Int]
  let grantBytesHex: String, grantSignature: String
  let identityBytesHex: String, identitySignature: String
}

func hex(_ s: String) -> Data {
  var d = Data(); var i = s.startIndex
  while i < s.endIndex { let n = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<n], radix: 16)!); i = n }
  return d
}
func b64url(_ s: String) -> Data {
  var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  while t.count % 4 != 0 { t += "=" }
  return Data(base64Encoded: t)!
}

let fx = try JSONDecoder().decode(Fx.self, from: try Data(contentsOf: URL(fileURLWithPath: "fixtures.json")))
let pub = try Curve25519.Signing.PublicKey(rawRepresentation: b64url(fx.publicKey))
let transcript = hex(fx.transcriptBytesHex)

let hashOk = Data(SHA256.hash(data: transcript)) == hex(fx.transcriptHashHex)

let sas = HKDF<SHA256>.deriveKey(
  inputKeyMaterial: SymmetricKey(data: hex(fx.transcriptHashHex)),
  salt: Data(repeating: 0, count: 32),
  info: Data("qm-sas-v1".utf8),
  outputByteCount: 8
)
var n: UInt64 = 0
sas.withUnsafeBytes { for b in $0 { n = (n << 8) | UInt64(b) } }
var digits = [Int](repeating: 0, count: 5)
for i in stride(from: 4, through: 0, by: -1) { digits[i] = Int(n % 7776); n /= 7776 }
let sasOk = digits == fx.sasDigits

func signed(_ label: String, _ body: Data) -> Data {
  var m = Data(label.utf8); m.append(0); m.append(body); return m
}
let tSigOk = pub.isValidSignature(b64url(fx.transcriptSignature), for: signed("qm-transcript-sign-v1", transcript))
let gSigOk = pub.isValidSignature(b64url(fx.grantSignature), for: signed("qm-grant-sign-v1", hex(fx.grantBytesHex)))
let iSigOk = pub.isValidSignature(b64url(fx.identitySignature), for: hex(fx.identityBytesHex))
let tamperRejected = !pub.isValidSignature(b64url(fx.grantSignature), for: signed("qm-grant-sign-v1", transcript))

print("{\"hashOk\": \(hashOk), \"sasOk\": \(sasOk), \"transcriptSigOk\": \(tSigOk), \"grantSigOk\": \(gSigOk), \"identitySigOk\": \(iSigOk), \"tamperRejected\": \(tamperRejected)}")
