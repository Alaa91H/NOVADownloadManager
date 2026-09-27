use nova_media_core::{YouTubeChallengeSolver, YouTubePlayerScriptSolver};

#[test]
fn verified_signature_transform_corpus() {
    let solver = YouTubePlayerScriptSolver;
    let cases = [
        (
            r#"
var H={
Rv:function(a){a.reverse()},
Sp:function(a,b){a.splice(0,b)},
Sw:function(a,b){var c=a[0];a[0]=a[b%a.length];a[b%a.length]=c}
};
SG=function(a){a=a.split("");H.Sw(a,2);H.Rv(a);H.Sp(a,1);return a.join("")};
"#,
            "abcdef",
            "edabc",
        ),
        (
            r#"
var H={Rv:function(a){a.reverse()},Sp:function(a,b){a.splice(0,b)}};
SG=function(a){a=a.split(""),H.Rv(a),H.Sp(a,2);return a.join("")};
"#,
            "abcdef",
            "dcba",
        ),
    ];

    for (player, input, expected) in cases {
        assert_eq!(
            solver
                .decipher_signature(player, input)
                .expect("verified signature transform"),
            expected
        );
    }
}

#[test]
fn verified_throttling_transform_corpus() {
    let solver = YouTubePlayerScriptSolver;
    let cases = [
        (
            r#"
var OPS={
Rv:function(a){a.reverse()},
Sp:function(a,b){a.splice(0,b)}
};
var H=[OPS.Rv,OPS["Sp"]];
NT=function(a){a=a.split("");H[0](a);H[1](a,2);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#,
            "abcdef",
            "dcba",
        ),
        (
            r#"
var OPS={Nt:function(a){a=a.split("");a.reverse();return a.join("")}};
var NX=[OPS.Nt];
function apply(p){var x=p.get("n");x&&(x=NX[0](x),p.set("n",x))}
"#,
            "abcdef",
            "fedcba",
        ),
        (
            r#"
var H={Sw:function(a,b){a[0]=a.splice(b%a.length,1,a[0])[0]}};
NT=function(a){a=a.split("");H.Sw(a,2);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#,
            "abcdef",
            "cbadef",
        ),
        (
            r#"
var H={Rv:function(a){a.reverse()},Sp:function(a,b){a.splice(0,b)}};
NT=function(a){a=a.split(""),H.Rv(a),H.Sp(a,1);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#,
            "abcdef",
            "edcba",
        ),
    ];

    for (player, input, expected) in cases {
        assert_eq!(
            solver
                .transform_throttling_parameter(player, input)
                .expect("verified throttling transform"),
            expected
        );
    }
}

#[test]
fn unverified_player_patterns_fail_closed() {
    let solver = YouTubePlayerScriptSolver;

    let unknown_helper = r#"
var OPS={Bad:function(a){a.push("x")}};
var H=[OPS.Bad];
NT=function(a){a=a.split("");H[0](a);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
    assert!(solver
        .transform_throttling_parameter(unknown_helper, "abcdef")
        .is_err());

    let compound_return = r#"
NT=function(a){a=a.split("");return a.reverse(),a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
    assert!(solver
        .transform_throttling_parameter(compound_return, "abcdef")
        .is_err());

    let no_verified_call_site =
        r#"NT=function(a){a=a.split("");a.reverse();return a.join("")};"#;
    assert!(solver
        .transform_throttling_parameter(no_verified_call_site, "abcdef")
        .is_err());
}
